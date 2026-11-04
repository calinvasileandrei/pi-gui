// MCP support. pi has none built in ("No MCP" — README), so the GUI server is the MCP client:
// it reads mcp.json, keeps one connection per (project, server), and the gui-bridge extension
// registers each server's tools in pi and forwards calls here over the loopback bridge.
//
// Config files (the de-facto `mcpServers` format used by Claude Desktop, Cursor, Claude Code):
//   global:  ~/.pi/agent/mcp.json
//   project: <project>/.pi/mcp.json     (same server name → project wins)
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema as ToolListChanged } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpServerConfig, McpServerInfo, McpToolInfo } from "@pi-gui/protocol";
import { PI_AGENT_DIR } from "./terminals/profiles.ts";

export const McpServerSchema = z
  .object({
    type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
    disabledTools: z.array(z.string()).optional(),
    /** per tool call, ms */
    timeout: z.number().int().positive().optional(),
  })
  .passthrough()
  .refine((s) => !!s.command || !!s.url, { message: "needs either a command (local server) or a url (remote server)" });

export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

export const mcpFile = (scope: "global" | "project", project?: string) => (scope === "global" ? join(PI_AGENT_DIR, "mcp.json") : join(project!, ".pi", "mcp.json"));

type FileShape = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

async function readJson(file: string): Promise<FileShape> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw == null || !raw.trim()) return {};
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    throw new Error(`${file} is not valid JSON — fix it first`);
  }
}
async function writeJson(file: string, data: FileShape) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); // may hold tokens
  await rename(tmp, file);
}

export interface ResolvedServer {
  name: string;
  scope: "global" | "project";
  file: string;
  config: McpServerConfig;
  /** config error (invalid entry) — shown instead of connecting */
  invalid?: string;
}

/** Effective servers for a project: global + project, project overriding by name. */
export async function loadMcpConfig(project?: string): Promise<{ servers: ResolvedServer[]; errors: string[] }> {
  const errors: string[] = [];
  const byName = new Map<string, ResolvedServer>();
  const scopes: ("global" | "project")[] = project ? ["global", "project"] : ["global"];
  for (const scope of scopes) {
    const file = mcpFile(scope, project);
    let data: FileShape;
    try {
      data = await readJson(file);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
      const p = McpServerSchema.safeParse(raw);
      byName.set(name, {
        name,
        scope,
        file,
        config: (p.success ? p.data : (raw as McpServerConfig)) ?? {},
        invalid: p.success ? undefined : p.error.issues.map((i) => i.message).join("; "),
      });
    }
  }
  return { servers: [...byName.values()], errors };
}

export async function saveServer(scope: "global" | "project", project: string | undefined, name: string, config: McpServerConfig, oldName?: string) {
  if (!SERVER_NAME.test(name)) throw new Error("server name: letters, digits, . _ - (max 48)");
  const parsed = McpServerSchema.parse(config);
  const file = mcpFile(scope, project);
  const data = await readJson(file);
  const servers = { ...(data.mcpServers ?? {}) };
  if (oldName && oldName !== name) {
    if (servers[name]) throw new Error(`a server named "${name}" already exists`);
    delete servers[oldName];
  }
  servers[name] = clean(parsed);
  await writeJson(file, { ...data, mcpServers: servers });
}

export async function patchServer(scope: "global" | "project", project: string | undefined, name: string, patch: Partial<McpServerConfig>) {
  const file = mcpFile(scope, project);
  const data = await readJson(file);
  const cur = data.mcpServers?.[name];
  if (!cur || typeof cur !== "object") throw new Error(`no server "${name}" in ${file}`);
  const next = clean({ ...(cur as McpServerConfig), ...patch });
  await writeJson(file, { ...data, mcpServers: { ...data.mcpServers, [name]: next } });
}

export async function removeServer(scope: "global" | "project", project: string | undefined, name: string) {
  const file = mcpFile(scope, project);
  const data = await readJson(file);
  if (!data.mcpServers?.[name]) return;
  const servers = { ...data.mcpServers };
  delete servers[name];
  await writeJson(file, { ...data, mcpServers: servers });
}

/** drop empty/default fields so the file stays tidy and portable */
function clean(c: McpServerConfig): McpServerConfig {
  const o: Record<string, unknown> = { ...c };
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) delete o[k];
  }
  if (o.disabled === false) delete o.disabled;
  return o as McpServerConfig;
}

// ---------------------------------------------------------------- import from other apps

export interface ImportSource {
  id: string;
  label: string;
  file: string;
  servers: Record<string, McpServerConfig>;
}

/** MCP configs other tools on this Mac already have — offered as one-click imports. */
export async function findImportSources(project?: string): Promise<ImportSource[]> {
  const h = homedir();
  const cands: { id: string; label: string; file: string; key?: string; pick?: (j: any) => Record<string, unknown> | undefined }[] = [
    { id: "claude-desktop", label: "Claude Desktop", file: join(h, "Library/Application Support/Claude/claude_desktop_config.json") },
    { id: "cursor", label: "Cursor", file: join(h, ".cursor/mcp.json") },
    { id: "windsurf", label: "Windsurf", file: join(h, ".codeium/windsurf/mcp_config.json") },
    { id: "claude-code", label: "Claude Code (user)", file: join(h, ".claude.json") },
    { id: "vscode", label: "VS Code (user)", file: join(h, "Library/Application Support/Code/User/mcp.json"), key: "servers" },
  ];
  if (project) {
    cands.push(
      { id: "project-mcp", label: "This project's .mcp.json", file: join(project, ".mcp.json") },
      { id: "project-cursor", label: "This project's .cursor/mcp.json", file: join(project, ".cursor/mcp.json") },
      { id: "project-vscode", label: "This project's .vscode/mcp.json", file: join(project, ".vscode/mcp.json"), key: "servers" },
    );
  }
  const out: ImportSource[] = [];
  for (const c of cands) {
    if (!existsSync(c.file)) continue;
    try {
      const j = JSON.parse(await readFile(c.file, "utf8"));
      const raw = (j?.[c.key ?? "mcpServers"] ?? {}) as Record<string, unknown>;
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, v] of Object.entries(raw)) {
        const p = McpServerSchema.safeParse(v);
        if (p.success && SERVER_NAME.test(name)) servers[name] = clean(p.data);
      }
      if (Object.keys(servers).length) out.push({ id: c.id, label: c.label, file: c.file, servers });
    } catch {
      /* unreadable or not JSON: not offered */
    }
  }
  return out;
}

// ---------------------------------------------------------------- connections

/** ${VAR} and ${env:VAR} from the GUI's environment, so tokens can stay out of the file */
export function expandVars(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k: string) => env[k] ?? "");
}
const expandMap = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, expandVars(v)])) : undefined);

const SCRUB = /^(PI_GUI_|ELECTRON_RUN_AS_NODE$)/;
function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && !SCRUB.test(k)) env[k] = v;
  return { ...env, ...expandMap(extra) };
}

export const transportOf = (c: McpServerConfig): "stdio" | "http" | "sse" => (c.command && !c.url ? "stdio" : c.type === "sse" || (!c.type && /\/sse\/?$/.test(c.url ?? "")) ? "sse" : "http");

const sigOf = (c: McpServerConfig, root: string) => createHash("sha1").update(JSON.stringify([root, c.command, c.args, c.env, c.cwd, c.url, c.headers, c.type])).digest("hex").slice(0, 12);

interface Conn {
  key: string;
  root: string;
  name: string;
  scope: "global" | "project";
  sig: string;
  config: McpServerConfig;
  status: McpServerInfo["status"];
  error?: string;
  stderr: string[];
  tools: McpToolInfo[];
  client?: Client;
  transport?: Transport;
  connecting?: Promise<void>;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  lastUsed: number;
  startedAt?: number;
}

const toolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

export interface BridgeTool {
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpManager {
  private conns = new Map<string, Conn>();
  private sweep: NodeJS.Timeout;

  constructor(
    private o: {
      /** a server's status/tools changed */
      onChange: (root: string) => void;
      /** project roots with a live pi session (idle connections elsewhere are closed) */
      liveRoots: () => Set<string>;
      idleMs?: number;
    },
  ) {
    this.sweep = setInterval(() => this.closeIdle(), 60_000);
    this.sweep.unref();
  }

  /** connection key: a project-scoped server belongs to that project; a global one is still started per project (cwd matters to most servers) */
  private key = (root: string, name: string) => `${root}\0${name}`;

  /** Status of every configured server for a project (does not connect). */
  async status(project?: string): Promise<{ servers: McpServerInfo[]; errors: string[] }> {
    const root = project ? resolve(project) : homedir();
    const { servers, errors } = await loadMcpConfig(project && resolve(project));
    return {
      errors,
      servers: servers.map((s) => {
        const c = this.conns.get(this.key(root, s.name));
        const fresh = c && c.sig === sigOf(s.config, root);
        const disabledTools = new Set(s.config.disabledTools ?? []);
        return {
          name: s.name,
          scope: s.scope,
          file: s.file,
          config: s.config,
          transport: transportOf(s.config),
          status: s.invalid ? "error" : s.config.disabled ? "disabled" : fresh ? c!.status : "idle",
          error: s.invalid ?? (fresh ? c!.error : undefined),
          stderr: fresh ? c!.stderr.slice(-40) : [],
          tools: (fresh ? c!.tools : []).map((t) => ({ ...t, enabled: !disabledTools.has(t.name) })),
          serverName: fresh ? c!.serverName : undefined,
          serverVersion: fresh ? c!.serverVersion : undefined,
          startedAt: fresh ? c!.startedAt : undefined,
        };
      }),
    };
  }

  /**
   * Tools for the pi sessions of a project. Connects every enabled server (in parallel, bounded by
   * `waitMs` so a slow server never stalls a prompt — it shows up on the next sync).
   */
  async toolsFor(project: string, waitMs = 8000): Promise<{ tools: BridgeTool[]; pending: string[]; instructions: string[] }> {
    const root = resolve(project);
    const { servers } = await loadMcpConfig(root);
    const active = servers.filter((s) => !s.invalid && !s.config.disabled);
    this.dropStale(root, active);
    const conns = active.map((s) => this.ensure(root, s));
    const timer = new Promise<void>((r) => setTimeout(r, waitMs).unref());
    await Promise.race([Promise.allSettled(conns.map((c) => c.connecting ?? Promise.resolve())), timer]);
    const tools: BridgeTool[] = [];
    const pending: string[] = [];
    const instructions: string[] = [];
    for (const c of conns) {
      c.lastUsed = Date.now();
      if (c.status === "connecting") pending.push(c.name);
      if (c.status !== "connected") continue;
      if (c.instructions) instructions.push(`${c.name}: ${c.instructions.slice(0, 1500)}`);
      const off = new Set(c.config.disabledTools ?? []);
      for (const t of c.tools) {
        if (off.has(t.name)) continue;
        tools.push({ name: toolName(c.name, t.name), server: c.name, tool: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } });
      }
    }
    return { tools, pending, instructions };
  }

  async call(project: string, server: string, tool: string, args: unknown, signal?: AbortSignal) {
    const root = resolve(project);
    const c = this.conns.get(this.key(root, server));
    if (!c) throw new Error(`MCP server "${server}" is not running for this project — it may have been removed or disabled`);
    if (c.connecting) await c.connecting;
    if (c.status !== "connected" || !c.client) throw new Error(`MCP server "${server}" is ${c.status}${c.error ? `: ${c.error}` : ""}`);
    if (c.config.disabledTools?.includes(tool)) throw new Error(`tool "${tool}" is disabled for ${server}`);
    c.lastUsed = Date.now();
    return c.client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
      signal,
      timeout: c.config.timeout ?? 5 * 60_000,
      resetTimeoutOnProgress: true,
    });
  }

  /** (Re)connect one server now — "Test" / "Restart" in the UI. */
  async restart(project: string | undefined, name: string): Promise<void> {
    const root = project ? resolve(project) : homedir();
    const { servers } = await loadMcpConfig(project && root);
    const s = servers.find((x) => x.name === name);
    if (!s) throw new Error(`no MCP server "${name}"`);
    if (s.invalid) throw new Error(s.invalid);
    await this.close(this.key(root, name));
    const c = this.ensure(root, s);
    await c.connecting;
    if (c.status === "error") throw new Error(c.error ?? "failed to connect");
  }

  async stop(project: string | undefined, name: string) {
    await this.close(this.key(project ? resolve(project) : homedir(), name));
  }

  /** Config changed on disk: close connections whose config no longer matches. */
  async reconcile(project?: string) {
    const roots = project ? [resolve(project)] : [...new Set([...this.conns.values()].map((c) => c.root))];
    for (const root of roots) {
      const { servers } = await loadMcpConfig(root === homedir() ? undefined : root);
      this.dropStale(root, servers.filter((s) => !s.invalid && !s.config.disabled));
      for (const s of servers) {
        const c = this.conns.get(this.key(root, s.name));
        if (c && c.sig === sigOf(s.config, root)) c.config = s.config; // tool toggles, timeout: no reconnect needed
      }
    }
  }

  async closeAll() {
    clearInterval(this.sweep);
    await Promise.allSettled([...this.conns.keys()].map((k) => this.close(k)));
  }

  // ----------------------------------------------------------------

  private dropStale(root: string, active: ResolvedServer[]) {
    const want = new Map(active.map((s) => [s.name, sigOf(s.config, root)]));
    for (const c of this.conns.values()) if (c.root === root && want.get(c.name) !== c.sig) void this.close(c.key);
  }

  private closeIdle() {
    const live = this.o.liveRoots();
    const idle = this.o.idleMs ?? 10 * 60_000;
    for (const c of this.conns.values()) if (!live.has(c.root) && Date.now() - c.lastUsed > idle) void this.close(c.key);
  }

  private async close(key: string) {
    const c = this.conns.get(key);
    if (!c) return;
    this.conns.delete(key);
    await c.client?.close().catch(() => {});
    this.o.onChange(c.root);
  }

  private ensure(root: string, s: ResolvedServer): Conn {
    const key = this.key(root, s.name);
    const sig = sigOf(s.config, root);
    const cur = this.conns.get(key);
    if (cur && cur.sig === sig && cur.status !== "error") {
      cur.config = s.config;
      return cur;
    }
    if (cur) void this.close(key);
    const c: Conn = { key, root, name: s.name, scope: s.scope, sig, config: s.config, status: "connecting", stderr: [], tools: [], lastUsed: Date.now() };
    this.conns.set(key, c);
    this.o.onChange(root);
    c.connecting = this.connect(c).finally(() => {
      c.connecting = undefined;
      this.o.onChange(root);
    });
    return c;
  }

  private async connect(c: Conn) {
    const cfg = c.config;
    try {
      let transport: Transport;
      const kind = transportOf(cfg);
      if (kind === "stdio") {
        const t = new StdioClientTransport({
          command: expandVars(cfg.command!),
          args: (cfg.args ?? []).map((a) => expandVars(a)),
          env: childEnv(cfg.env),
          cwd: cfg.cwd ? resolve(c.root, expandVars(cfg.cwd).replace(/^~(?=$|\/)/, homedir())) : c.root,
          stderr: "pipe",
        });
        t.stderr?.on("data", (d: Buffer) => {
          for (const line of d.toString("utf8").split("\n")) if (line.trim()) c.stderr.push(line.slice(0, 500));
          if (c.stderr.length > 200) c.stderr.splice(0, c.stderr.length - 200);
        });
        transport = t;
      } else {
        const url = new URL(expandVars(cfg.url!));
        const headers = expandMap(cfg.headers);
        transport = kind === "sse" ? new SSEClientTransport(url, { requestInit: { headers } }) : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      }
      const client = new Client({ name: "pi-gui", version: "0.1.0" }, { capabilities: {} });
      client.onclose = () => {
        if (this.conns.get(c.key) !== c) return;
        if (c.status === "connected") {
          c.status = "error";
          c.error = "the server exited" + (c.stderr.length ? ` — ${c.stderr[c.stderr.length - 1]}` : "");
          this.o.onChange(c.root);
        }
      };
      c.transport = transport;
      c.client = client;
      await withTimeout(client.connect(transport), 30_000, "timed out connecting (30 s)");
      const v = client.getServerVersion();
      c.serverName = v?.name;
      c.serverVersion = v?.version;
      c.instructions = client.getInstructions();
      c.tools = await this.listTools(client);
      client.setNotificationHandler(ToolListChanged, async () => {
        c.tools = await this.listTools(client).catch(() => c.tools);
        this.o.onChange(c.root);
      });
      c.status = "connected";
      c.startedAt = Date.now();
      c.error = undefined;
    } catch (e) {
      c.status = "error";
      const tail = c.stderr.slice(-3).join(" · ");
      c.error = friendly((e as Error).message, c.config) + (tail && !/exited/.test(tail) ? `\n${tail}` : "");
      await c.client?.close().catch(() => {});
    }
  }

  private async listTools(client: Client): Promise<McpToolInfo[]> {
    if (!client.getServerCapabilities()?.tools) return [];
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of r.tools) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, title: t.title ?? t.annotations?.title, readOnly: t.annotations?.readOnlyHint, destructive: t.annotations?.destructiveHint });
      cursor = r.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}

function friendly(msg: string, c: McpServerConfig): string {
  if (/ENOENT/.test(msg) && c.command) return `command not found: ${c.command} — is it installed and on your PATH?`;
  if (/ECONNREFUSED/.test(msg)) return `connection refused: ${c.url}`;
  if (/\b401\b|Unauthorized/i.test(msg)) return `unauthorized (401) — check the server's headers / token. ${msg}`;
  return msg;
}

/** Flatten an MCP tool result into pi tool-result content. */
export function toPiContent(r: { content?: unknown[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown }): { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError: boolean } {
  const out: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
  const items = Array.isArray(r.content) ? (r.content as Record<string, any>[]) : [];
  for (const it of items) {
    if (it.type === "text") out.push({ type: "text", text: String(it.text ?? "") });
    else if (it.type === "image" && it.data) out.push({ type: "image", data: it.data, mimeType: it.mimeType ?? "image/png" });
    else if (it.type === "resource") {
      const res = it.resource ?? {};
      out.push({ type: "text", text: res.text != null ? `[${res.uri ?? "resource"}]\n${res.text}` : `[binary resource ${res.uri ?? ""} (${res.mimeType ?? "unknown type"})]` });
    } else if (it.type === "resource_link") out.push({ type: "text", text: `[resource link] ${it.name ?? ""} ${it.uri ?? ""}`.trim() });
    else if (it.type === "audio") out.push({ type: "text", text: `[audio ${it.mimeType ?? ""} — not shown]` });
  }
  if (!out.length && r.structuredContent !== undefined) out.push({ type: "text", text: JSON.stringify(r.structuredContent, null, 2) });
  if (!out.length && r.toolResult !== undefined) out.push({ type: "text", text: typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult, null, 2) });
  if (!out.length) out.push({ type: "text", text: "(no output)" });
  return { content: out, isError: !!r.isError };
}
