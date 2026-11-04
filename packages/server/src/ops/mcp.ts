import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServerConfig } from "@pi-gui/protocol";
import type { Bus } from "../bus.ts";
import type { OpContext, OpHandler } from "../http.ts";
import type { Supervisor } from "../sessions.ts";
import { McpManager, McpServerSchema, findImportSources, loadMcpConfig, mcpFile, patchServer, removeServer, saveServer, toPiContent } from "../mcp.ts";
import { expandHome } from "./sessions.ts";

const Scope = z.enum(["global", "project"]);
const Target = z.object({ scope: Scope, project: z.string().optional(), name: z.string().min(1) });
const dir = (p?: string) => (p ? resolve(expandHome(p)) : undefined);

export function mcpOps({ sup, bus }: { sup: Supervisor; bus: Bus }) {
  const liveRoots = () => new Set(sup.list().filter((s) => s.status === "idle" || s.status === "streaming").map((s) => resolve(s.cwd)));
  const mcp = new McpManager({ onChange: (root) => bus.publish("app", { kind: "mcp_changed", root }), liveRoots });

  const need = (scope: "global" | "project", project?: string) => {
    if (scope === "project" && !project) throw new Error("open a project folder first");
    return dir(project);
  };
  const caller = (ctx: OpContext) => {
    if (!ctx.callerSession || !sup.sessions.has(ctx.callerSession)) throw new Error("unknown calling session");
    return sup.get(ctx.callerSession);
  };
  /** after a config write: drop connections whose config changed, tell every window */
  const changed = async (project?: string) => {
    await mcp.reconcile(project);
    bus.publish("app", { kind: "mcp_changed", root: project ?? "" });
  };

  const ops: Record<string, OpHandler> = {
    "mcp.list": (a) => mcp.status(dir(z.object({ project: z.string().optional() }).parse(a).project)),
    "mcp.save": async (a) => {
      const p = Target.extend({ config: z.record(z.string(), z.unknown()), oldName: z.string().optional() }).parse(a);
      const project = need(p.scope, p.project);
      await saveServer(p.scope, project, p.name, p.config as McpServerConfig, p.oldName);
      await changed(project);
      if (!(p.config as McpServerConfig).disabled) void mcp.restart(project, p.name).catch(() => {}); // connect right away so the UI shows tools/errors
      return { ok: true };
    },
    "mcp.setEnabled": async (a) => {
      const p = Target.extend({ enabled: z.boolean() }).parse(a);
      const project = need(p.scope, p.project);
      await patchServer(p.scope, project, p.name, { disabled: !p.enabled });
      if (!p.enabled) await mcp.stop(project, p.name);
      await changed(project);
      if (p.enabled) void mcp.restart(project, p.name).catch(() => {});
      return { ok: true };
    },
    "mcp.setToolEnabled": async (a) => {
      const p = Target.extend({ tool: z.string(), enabled: z.boolean() }).parse(a);
      const project = need(p.scope, p.project);
      const { servers } = await loadMcpConfig(project);
      const cur = servers.find((s) => s.name === p.name && s.scope === p.scope);
      const off = new Set(cur?.config.disabledTools ?? []);
      p.enabled ? off.delete(p.tool) : off.add(p.tool);
      await patchServer(p.scope, project, p.name, { disabledTools: [...off] });
      await changed(project);
      return { ok: true };
    },
    "mcp.remove": async (a) => {
      const p = Target.parse(a);
      const project = need(p.scope, p.project);
      await removeServer(p.scope, project, p.name);
      await mcp.stop(project, p.name);
      await changed(project);
      return { ok: true };
    },
    "mcp.restart": async (a) => {
      const p = z.object({ project: z.string().optional(), name: z.string() }).parse(a);
      await mcp.restart(dir(p.project), p.name);
      return { ok: true };
    },
    "mcp.stop": async (a) => {
      const p = z.object({ project: z.string().optional(), name: z.string() }).parse(a);
      await mcp.stop(dir(p.project), p.name);
      return { ok: true };
    },
    "mcp.importSources": (a) => findImportSources(dir(z.object({ project: z.string().optional() }).parse(a).project)),
    "mcp.import": async (a) => {
      const p = z.object({ source: z.string(), names: z.array(z.string()).min(1), scope: Scope, project: z.string().optional(), overwrite: z.boolean().default(false) }).parse(a);
      const project = need(p.scope, p.project);
      const src = (await findImportSources(project)).find((s) => s.id === p.source);
      if (!src) throw new Error("that config file is gone");
      const existing = new Set((await loadMcpConfig(project)).servers.filter((s) => s.scope === p.scope).map((s) => s.name));
      const added: string[] = [];
      const skipped: string[] = [];
      for (const name of p.names) {
        const cfg = src.servers[name];
        if (!cfg) continue;
        if (existing.has(name) && !p.overwrite) {
          skipped.push(name);
          continue;
        }
        await saveServer(p.scope, project, name, cfg);
        added.push(name);
      }
      await changed(project);
      return { added, skipped };
    },
    /** the raw file, for the JSON editor */
    "mcp.readFile": async (a) => {
      const p = z.object({ scope: Scope, project: z.string().optional() }).parse(a);
      const file = mcpFile(p.scope, need(p.scope, p.project));
      const text = await readFile(file, "utf8").catch(() => "");
      return { file, text: text.trim() ? text : `{\n  "mcpServers": {}\n}\n` };
    },
    "mcp.writeFile": async (a) => {
      const p = z.object({ scope: Scope, project: z.string().optional(), text: z.string() }).parse(a);
      const project = need(p.scope, p.project);
      let j: { mcpServers?: Record<string, unknown> };
      try {
        j = JSON.parse(p.text);
      } catch (e) {
        throw new Error(`not valid JSON: ${(e as Error).message}`);
      }
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("the file must be a JSON object");
      for (const [name, v] of Object.entries(j.mcpServers ?? {})) {
        const r = McpServerSchema.safeParse(v);
        if (!r.success) throw new Error(`"${name}": ${r.error.issues.map((i) => i.message).join("; ")}`);
      }
      const { writeFile, mkdir } = await import("node:fs/promises");
      const file = mcpFile(p.scope, project);
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, p.text.endsWith("\n") ? p.text : p.text + "\n", { mode: 0o600 });
      await changed(project);
      return { ok: true };
    },

    // ---------- bridge (gui-bridge extension inside pi) ----------
    "bridge.mcpTools": async (a, ctx) => {
      const s = caller(ctx);
      const { waitMs } = z.object({ waitMs: z.number().int().min(0).max(30_000).default(8000) }).parse(a ?? {});
      return mcp.toolsFor(s.spec.cwd, waitMs);
    },
    "bridge.mcpCall": async (a, ctx) => {
      const s = caller(ctx);
      const p = z.object({ server: z.string(), tool: z.string(), args: z.unknown() }).parse(a);
      const r = await mcp.call(s.spec.cwd, p.server, p.tool, p.args, ctx.signal);
      return toPiContent(r as Parameters<typeof toPiContent>[0]);
    },
  };

  return { ops, httpOps: ["bridge.mcpTools", "bridge.mcpCall"], mcp, close: () => mcp.closeAll() };
}
