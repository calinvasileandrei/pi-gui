import { join, resolve } from "node:path";
import { z } from "zod";
import { THINKING_LEVELS, type ThinkingLevel } from "@pi-gui/protocol";
import type { OpContext, OpHandler } from "../http.ts";
import type { Supervisor } from "../sessions.ts";
import type { ChangeTracker } from "../changes.ts";
import type { RunManager } from "../runs.ts";
import type { PtyManager } from "../terminals/pty.ts";
import { addExtension, fetchGitExtension, inspectExtension, listExtensions, setExtensionEnabled } from "../extensions.ts";
import { deleteAgent, loadAgents, saveAgent, validateAgent } from "../agents.ts";
import { listStoredSessions, renameStoredSession, trashStoredSession } from "../stored-sessions.ts";
import { expandHome } from "./sessions.ts";

export interface FeatureDeps {
  sup: Supervisor;
  changes: ChangeTracker;
  runs: RunManager;
  ptys: PtyManager;
  guiDir: string;
  bridgePath: string;
}

const Id = z.object({ id: z.string() });
const dir = (p: string) => resolve(expandHome(p));

/** The calling pi session for bridge ops — always taken from the header the server injected, never from args. */
function caller(ctx: OpContext, sup: Supervisor) {
  if (!ctx.callerSession || !sup.sessions.has(ctx.callerSession)) throw new Error("unknown calling session");
  return sup.get(ctx.callerSession);
}

export function featureOps(d: FeatureDeps): { ops: Record<string, OpHandler>; httpOps: string[] } {
  const { sup, changes, runs, ptys } = d;
  const trash = join(d.guiDir, "trash");

  const ops: Record<string, OpHandler> = {
    // ---------- M3 changes ----------
    "changes.list": async (a) => {
      const s = sup.get(Id.parse(a).id);
      return changes.list(s.id, s.spec.cwd);
    },
    "changes.diff": async (a) => {
      const { id, path, base } = z.object({ id: z.string(), path: z.string(), base: z.enum(["head", "agent"]).default("head") }).parse(a);
      const s = sup.get(id);
      return changes.diff(s.id, s.spec.cwd, path, base);
    },
    "changes.revert": async (a) => {
      const { id, path, base } = z.object({ id: z.string(), path: z.string(), base: z.enum(["head", "agent"]).default("head") }).parse(a);
      const s = sup.get(id);
      await changes.revert(s.id, s.spec.cwd, path, base, trash);
      return changes.list(s.id, s.spec.cwd);
    },

    // ---------- M8 pre-apply approvals ----------
    "approvals.setMode": (a) => {
      const { id, enabled } = z.object({ id: z.string(), enabled: z.boolean() }).parse(a);
      sup.get(id);
      if (enabled) changes.approvalMode.add(id);
      else changes.approvalMode.delete(id);
      return { enabled };
    },
    "approvals.get": (a) => {
      const { id } = Id.parse(a);
      return { enabled: changes.approvalMode.has(id), pending: changes.pendingFor(id) };
    },
    "approvals.decide": (a) => {
      const { requestId, approve, reason } = z.object({ requestId: z.string(), approve: z.boolean(), reason: z.string().optional() }).parse(a);
      changes.decide(requestId, approve, reason);
    },

    // ---------- M4 stored sessions ----------
    "stored.list": async (a) => {
      const { cwd } = z.object({ cwd: z.string().optional() }).parse(a);
      const open = new Map(sup.list().filter((s) => s.sessionFile).map((s) => [s.sessionFile!, s.id]));
      return (await listStoredSessions(cwd ? dir(cwd) : undefined)).map((s) => ({ ...s, openId: open.get(s.file) }));
    },
    "stored.rename": async (a) => {
      const { file, name } = z.object({ file: z.string(), name: z.string().min(1).max(200) }).parse(a);
      const open = sup.list().find((s) => s.sessionFile === file && (s.status === "idle" || s.status === "streaming"));
      if (open) {
        await sup.get(open.id).requireProc().call({ type: "set_session_name", name });
        await sup.get(open.id).refreshState();
        sup.publishList();
      } else await renameStoredSession(file, name);
    },
    "stored.delete": async (a) => {
      const { file } = z.object({ file: z.string() }).parse(a);
      for (const s of sup.list().filter((x) => x.sessionFile === file)) await sup.remove(s.id);
      await trashStoredSession(file, trash);
    },

    // ---------- M5 extensions ----------
    "ext.list": async (a) => listExtensions(z.object({ project: z.string().optional() }).parse(a).project ? dir((a as { project: string }).project) : undefined, d.bridgePath),
    "ext.toggle": async (a) => {
      const { project, path, scope, source, enabled } = z
        .object({ project: z.string().optional(), path: z.string(), scope: z.enum(["global", "project"]), source: z.enum(["auto", "settings", "package"]), enabled: z.boolean() })
        .parse(a);
      if (path === d.bridgePath) throw new Error("gui-bridge is built in");
      await setExtensionEnabled({ path, scope, source }, enabled, project ? dir(project) : undefined);
      return affected(scope, project);
    },
    "ext.inspect": async (a) => inspectExtension(dir(z.object({ path: z.string() }).parse(a).path)),
    "ext.fetchGit": async (a) => {
      const { url } = z.object({ url: z.string() }).parse(a);
      const path = await fetchGitExtension(url, d.guiDir);
      return { path, ...(await inspectExtension(path)) };
    },
    "ext.add": async (a) => {
      const { path, scope, project } = z.object({ path: z.string(), scope: z.enum(["global", "project"]), project: z.string().optional() }).parse(a);
      await addExtension(dir(path), scope, project ? dir(project) : undefined);
      return affected(scope, project);
    },

    // ---------- M6 agents ----------
    "agents.list": async (a) => {
      const { project } = z.object({ project: z.string().optional() }).parse(a);
      return loadAgents(project ? dir(project) : undefined);
    },
    "agents.validate": (a) => {
      const { agent, models } = z.object({ agent: z.object({ name: z.string(), tools: z.array(z.string()).optional(), model: z.string().optional() }), models: z.array(z.string()).optional() }).parse(a);
      return validateAgent(agent, { models });
    },
    "agents.save": async (a) => {
      const p = z
        .object({
          project: z.string().optional(),
          previousFile: z.string().optional(),
          agent: z.object({
            name: z.string(),
            description: z.string().default(""),
            model: z.string().optional(),
            thinking: z.enum(THINKING_LEVELS as [ThinkingLevel, ...ThinkingLevel[]]).optional(),
            tools: z.array(z.string()).optional(),
            extensions: z.array(z.string()).optional(),
            maxTurns: z.number().int().positive().optional(),
            timeoutSec: z.number().int().positive().optional(),
            canSpawn: z.boolean().default(false),
            systemPrompt: z.string().default(""),
            scope: z.enum(["project", "global"]),
          }),
        })
        .parse(a);
      const problems = validateAgent(p.agent);
      if (problems.length) throw new Error(problems.join("; "));
      if (p.agent.scope === "project" && !p.project) throw new Error("project scope needs a project folder");
      return { file: await saveAgent(p.agent, p.project ? dir(p.project) : undefined, p.previousFile) };
    },
    "agents.delete": async (a) => {
      const { file, project } = z.object({ file: z.string(), project: z.string().optional() }).parse(a);
      await deleteAgent(file, project ? dir(project) : undefined);
    },

    // ---------- M6 runs (GUI side) ----------
    "runs.list": (a) => runs.listFor(Id.parse(a).id),
    "runs.kill": (a) => runs.kill(z.object({ runId: z.string() }).parse(a).runId),
    "runs.transcript": (a) => runs.transcript(z.object({ runId: z.string() }).parse(a).runId),
    "runs.notes": (a) => runs.notesFor(Id.parse(a).id),
    "runs.noteAppend": (a) => {
      const { id, text } = z.object({ id: z.string(), text: z.string().min(1) }).parse(a);
      return runs.appendNote(id, text);
    },
    "runs.questions": (a) => runs.openQuestions(runs.rootOf(Id.parse(a).id)),
    "runs.answer": (a) => {
      const { questionId, text } = z.object({ questionId: z.string(), text: z.string().min(1) }).parse(a);
      runs.answer(questionId, text);
    },

    // ---------- bridge (called by the gui-bridge extension inside pi, over HTTP) ----------
    "bridge.beforeWrite": async (a, ctx) => {
      const s = caller(ctx, sup);
      const { tool, path, input, cwd } = z.object({ tool: z.enum(["edit", "write"]), path: z.string(), input: z.record(z.string(), z.unknown()), cwd: z.string() }).parse(a);
      return changes.beforeWrite(s.id, cwd || s.spec.cwd, tool, path, input);
    },
    "bridge.agents": async (_a, ctx) => {
      const s = caller(ctx, sup);
      return (await loadAgents(s.spec.cwd)).agents.map((x) => ({ name: x.name, description: x.description }));
    },
    "bridge.subagent": async (a, ctx) => {
      const s = caller(ctx, sup);
      const p = z.object({ agent: z.string(), task: z.string().min(1), files: z.array(z.string()).optional(), context: z.string().optional(), toolCallId: z.string().optional() }).parse(a);
      return runs.run(s.id, p, ctx.signal);
    },
    "bridge.notesRead": (_a, ctx) => runs.notesFor(caller(ctx, sup).id),
    "bridge.notesAppend": (a, ctx) => runs.appendNote(caller(ctx, sup).id, z.object({ text: z.string().min(1) }).parse(a).text),
    "bridge.messageParent": (a, ctx) => runs.messageParent(caller(ctx, sup).id, z.object({ text: z.string().min(1) }).parse(a).text),
    "bridge.ask": (a, ctx) => runs.ask(caller(ctx, sup).id, z.object({ question: z.string().min(1) }).parse(a).question, ctx.signal),
    "bridge.terminalRead": (a) => {
      const { name, lines } = z.object({ name: z.string(), lines: z.number().int().min(1).max(2000).default(100) }).parse(a);
      const t = ptys.findByName(name);
      if (!t) throw new Error(`no terminal named "${name}". Running: ${ptys.list().map((x) => `${x.name} (${x.status})`).join(", ") || "none"}`);
      return { name: t.spec.name, status: t.status, exitCode: t.exitCode, lines: t.readLines(lines) };
    },
  };

  /** sessions that must restart for an extension change to apply */
  function affected(scope: "global" | "project", project?: string) {
    const p = project ? dir(project) : undefined;
    const ids = sup.list().filter((s) => !s.parentId && (s.status === "idle" || s.status === "streaming") && (scope === "global" || s.cwd === p)).map((s) => s.id);
    return { affectedSessions: ids };
  }

  return { ops, httpOps: Object.keys(ops).filter((k) => k.startsWith("bridge.")) };
}
