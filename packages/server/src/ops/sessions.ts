import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { THINKING_LEVELS, type ExtensionUiResponse, type ThinkingLevel } from "@pi-gui/protocol";
import type { OpHandler } from "../http.ts";
import type { Supervisor } from "../sessions.ts";
import type { Bus } from "../bus.ts";

const Id = z.object({ id: z.string() });

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

export function sessionOps(sup: Supervisor, bus: Bus): Record<string, OpHandler> {
  return {
    "session.list": () => sup.list(),

    "session.create": async (a) => {
      const { cwd, name, sessionFile, model, thinking } = z
        .object({
          cwd: z.string(),
          name: z.string().optional(),
          sessionFile: z.string().optional(),
          model: z.string().optional(),
          thinking: z.enum(THINKING_LEVELS as [ThinkingLevel, ...ThinkingLevel[]]).optional(),
        })
        .parse(a);
      const dir = resolve(expandHome(cwd));
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
      // already open? focus it instead of spawning a second pi on the same file
      if (sessionFile) {
        const open = [...sup.sessions.values()].find((s) => s.info().sessionFile === sessionFile && s.status !== "stopped");
        if (open) return open.info();
      }
      const args = [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
      const s = await sup.create({ cwd: dir, name, sessionFile, args });
      return s.info();
    },

    "session.snapshot": async (a) => {
      const { id } = Id.parse(a);
      const s = sup.get(id);
      const seq = bus.head(s.channel); // take head *before* reading messages so nothing is lost
      const [messages, state] = await Promise.all([s.messages().catch(() => []), s.refreshState().catch(() => s.state)]);
      return { info: s.info(), state, messages, seq };
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
      const { id, level } = z.object({ id: z.string(), level: z.enum(THINKING_LEVELS as [ThinkingLevel, ...ThinkingLevel[]]) }).parse(a);
      const s = sup.get(id);
      await s.requireProc().setThinking(level);
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
      sup.get(id).requireProc().respondUi({ ...response, type: "extension_ui_response" } as ExtensionUiResponse);
    },
  };
}
