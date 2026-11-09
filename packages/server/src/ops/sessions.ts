import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { THINKING_LEVELS, type ExtensionUiResponse, type ThinkingLevel } from "@pi-gui/protocol";
import type { OpHandler } from "../http.ts";
import type { ManagedSession, Supervisor } from "../sessions.ts";
import { CLAUDE_ALIAS_MODELS, ClaudeProcess, findClaudeBinary, isClaudeTranscript } from "../claude/adapter.ts";
import type { Bus } from "../bus.ts";

const Id = z.object({ id: z.string() });

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

const PermissionModeZ = z.enum(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);

export function sessionOps(sup: Supervisor, bus: Bus, defaults: { harness: () => "pi" | "claude" } = { harness: () => "pi" }): Record<string, OpHandler> {
  const spawnSpec = (cwd: string, harness: "pi" | "claude", model?: string, thinking?: string, extra: { name?: string; sessionFile?: string; permissionMode?: z.infer<typeof PermissionModeZ> } = {}) =>
    harness === "claude"
      ? { cwd, harness, name: extra.name, sessionFile: extra.sessionFile, claude: { model, effort: thinking, permissionMode: extra.permissionMode } }
      : { cwd, harness, name: extra.name, sessionFile: extra.sessionFile, args: [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])] };
  const hasHistory = async (s: ManagedSession) => (await s.messages().catch(() => [])).some((m) => m.role === "user");

  return {
    /** which agents can run sessions on this machine */
    "harness.list": () => {
      const claude = findClaudeBinary(sup.opts.claudeBin?.());
      return {
        default: defaults.harness(),
        harnesses: [
          { id: "pi", name: "pi", available: true },
          { id: "claude", name: "Claude Code", available: !!claude, bin: claude, models: CLAUDE_ALIAS_MODELS },
        ],
      };
    },

    "session.list": () => sup.list(),

    "session.create": async (a) => {
      const { cwd, name, sessionFile, model, thinking, harness, permissionMode } = z
        .object({
          cwd: z.string(),
          name: z.string().optional(),
          sessionFile: z.string().optional(),
          model: z.string().optional(),
          thinking: z.string().optional(),
          harness: z.enum(["pi", "claude"]).optional(),
          permissionMode: PermissionModeZ.optional(),
        })
        .parse(a);
      const dir = resolve(expandHome(cwd));
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
      // already open? focus it instead of spawning a second pi on the same file
      if (sessionFile) {
        const open = [...sup.sessions.values()].find((s) => s.info().sessionFile === sessionFile && s.status !== "stopped");
        if (open) return open.info();
      }
      const h = sessionFile ? (isClaudeTranscript(sessionFile) ? "claude" : "pi") : (harness ?? defaults.harness());
      if (h === "pi" && thinking && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) throw new Error(`unknown thinking level ${thinking}`);
      const s = await sup.create(spawnSpec(dir, h, model, thinking, { name, sessionFile, permissionMode }));
      return s.info();
    },

    /**
     * Pick a model from the other agent. A conversation can't move between pi and Claude Code,
     * so an empty session switches in place and one with history opens a new session next to it.
     */
    "session.switchHarness": async (a) => {
      const { id, harness, model } = z.object({ id: z.string(), harness: z.enum(["pi", "claude"]), model: z.string().optional() }).parse(a);
      const s = sup.get(id);
      if (s.harness === harness) throw new Error("already on that agent");
      if (!(await hasHistory(s))) {
        await sup.remove(id);
        const n = await sup.create(spawnSpec(s.spec.cwd, harness, model, undefined, { name: s.spec.name }));
        return { info: n.info(), replaced: true };
      }
      const n = await sup.create(spawnSpec(s.spec.cwd, harness, model));
      return { info: n.info(), replaced: false };
    },

    "session.setPermissionMode": async (a) => {
      const { id, mode } = z.object({ id: z.string(), mode: PermissionModeZ }).parse(a);
      const s = sup.get(id);
      const p = s.requireProc();
      if (!(p instanceof ClaudeProcess)) throw new Error("permission modes are for Claude Code sessions");
      await p.setPermissionMode(mode);
      await s.refreshState();
    },

    "session.snapshot": async (a) => {
      const { id } = Id.parse(a);
      const s = sup.get(id);
      const seq = bus.head(s.channel); // take head *before* reading messages so nothing is lost
      const [messages, state] = await Promise.all([s.messages().catch(() => []), s.refreshState().catch(() => s.state)]);
      return { info: s.info(), state, messages, seq, uiRequests: [...s.pendingUi.values()] };
    },

    "session.prompt": async (a) => {
      const { id, message, mode } = z
        .object({ id: z.string(), message: z.string().min(1), mode: z.enum(["auto", "steer", "followUp"]).default("auto") })
        .parse(a);
      const s = sup.get(id);
      const p = s.requireProc();
      if (mode === "steer") return p.steer(message);
      if (mode === "followUp") return p.followUp(message);
      // auto: always pass streamingBehavior. pi ignores it when idle and steers when streaming,
      // so there's no race with our cached status (agent_start may not have reached us yet).
      return p.prompt(message, "steer");
    },

    "session.abort": async (a) => {
      const s = sup.get(Id.parse(a).id);
      const p = s.requireProc();
      try {
        await p.call({ type: "abort" }, 5000);
      } catch {
        // pi unresponsive → guaranteed abort: kill and come back on the same session file
        await s.restart();
        return { hard: true };
      }
      return { hard: false };
    },

    "session.models": async (a) => (await sup.get(Id.parse(a).id).requireProc().getModels()).models,

    "session.setModel": async (a) => {
      const { id, provider, modelId } = z.object({ id: z.string(), provider: z.string(), modelId: z.string() }).parse(a);
      const s = sup.get(id);
      const m = await s.requireProc().setModel(provider, modelId);
      await s.refreshState();
      return m;
    },

    "session.setThinking": async (a) => {
      const { id, level } = z.object({ id: z.string(), level: z.string() }).parse(a);
      const s = sup.get(id);
      if (s.harness === "pi" && !THINKING_LEVELS.includes(level as ThinkingLevel)) throw new Error(`unknown thinking level ${level}`);
      await s.requireProc().setThinking(level as ThinkingLevel);
      await s.refreshState();
    },

    "session.stats": async (a) => sup.get(Id.parse(a).id).requireProc().getStats(),

    "session.commands": async (a) => sup.get(Id.parse(a).id).requireProc().call({ type: "get_commands" }),

    "session.rename": async (a) => {
      const { id, name } = z.object({ id: z.string(), name: z.string().min(1) }).parse(a);
      const s = sup.get(id);
      await s.requireProc().call({ type: "set_session_name", name });
      await s.refreshState();
      sup.publishList();
    },

    // `!cmd` in the composer, like pi's TUI: runs in the session cwd; output joins the context on the next prompt
    "session.bash": async (a) => {
      const { id, command } = z.object({ id: z.string(), command: z.string().min(1) }).parse(a);
      return sup.get(id).requireProc().call({ type: "bash", command }, 10 * 60_000);
    },

    "session.abortBash": async (a) => sup.get(Id.parse(a).id).requireProc().call({ type: "abort_bash" }),

    "session.compact": async (a) => sup.get(Id.parse(a).id).requireProc().call({ type: "compact" }, 300_000),

    "session.restart": async (a) => {
      const s = sup.get(Id.parse(a).id);
      await s.restart();
      return s.info();
    },

    "session.stop": async (a) => {
      await sup.get(Id.parse(a).id).stop();
    },

    "session.close": async (a) => {
      await sup.remove(Id.parse(a).id);
    },

    "session.uiRespond": async (a) => {
      const { id, response } = z.object({ id: z.string(), response: z.record(z.string(), z.unknown()) }).parse(a);
      const sess = sup.get(id);
      if (typeof response.id === "string") sess.pendingUi.delete(response.id);
      sess.requireProc().respondUi({ ...response, type: "extension_ui_response" } as ExtensionUiResponse);
    },
  };
}
