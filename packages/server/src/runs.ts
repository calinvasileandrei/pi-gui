import { randomUUID } from "node:crypto";
import type { AgentDefinition, AgentMessage, Note, ParentQuestion, RpcEvent, SubagentRun } from "@pi-gui/protocol";
import type { Bus } from "./bus.ts";
import { Semaphore, type ManagedSession, type Supervisor } from "./sessions.ts";
import { WRITE_TOOLS } from "./agents.ts";

export interface RunManagerOptions {
  concurrency: number;
  maxDepth: number;
  loadAgents: (project: string) => Promise<{ agents: AgentDefinition[] }>;
  resolveExtension: (nameOrPath: string, project: string) => Promise<string | undefined>;
  /** names of the MCP tools available in a project (to expand `mcp__server__*` in an agent's tools) */
  mcpTools?: (project: string) => Promise<string[]>;
  defaultMaxTurns?: number;
  defaultTimeoutSec?: number;
}

interface RunRec extends SubagentRun {
  progress: string[];
  transcript?: AgentMessage[];
  kill?: (status: "aborted" | "timeout" | "failed", why: string) => void;
}

const lastAssistantText = (msgs: AgentMessage[]) => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant") {
      const t = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n").trim();
      if (t) return t;
    }
  }
  return "";
};

/**
 * Subagent orchestration (plan §6): each child is its own `pi --mode rpc` with its own context.
 * Parent → child: a brief. Child → parent: a structured report (never the transcript).
 * Siblings: an append-only blackboard keyed by the root session.
 */
export class RunManager {
  readonly runs = new Map<string, RunRec>();
  private notes = new Map<string, Note[]>();
  private sem: Semaphore;
  private writers = new Map<string, Semaphore>();
  private questions = new Map<string, { q: ParentQuestion; resolve: (answer: string) => void }>();

  constructor(private sup: Supervisor, private bus: Bus, private o: RunManagerOptions) {
    this.sem = new Semaphore(o.concurrency);
  }

  setConcurrency(n: number) {
    this.sem.limit = n;
  }

  rootOf(sessionId: string): string {
    let id = sessionId;
    for (let i = 0; i < 10; i++) {
      const p = this.sup.sessions.get(id)?.spec.parentId;
      if (!p) return id;
      id = p;
    }
    return id;
  }

  /** `mcp__github__*` / `mcp__*` in an agent's tools → the matching MCP tool names right now */
  private async expandMcp(tools: string[], cwd: string): Promise<string[]> {
    if (!tools.some((t) => t.includes("*"))) return tools;
    const avail = (await this.o.mcpTools?.(cwd).catch(() => [])) ?? [];
    const out: string[] = [];
    for (const t of tools) {
      if (!t.includes("*")) out.push(t);
      else {
        const re = new RegExp(`^${t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        out.push(...avail.filter((n) => re.test(n)));
      }
    }
    return out;
  }

  private publish(parentSessionId: string) {
    const runs = [...this.runs.values()].filter((r) => r.parentSessionId === parentSessionId).map(({ kill: _k, transcript: _t, ...r }) => r);
    this.bus.publish(`session:${parentSessionId}`, { kind: "runs", parentSessionId, runs });
  }

  listFor(parentSessionId: string): SubagentRun[] {
    return [...this.runs.values()].filter((r) => r.parentSessionId === parentSessionId).map(({ kill: _k, transcript: _t, ...r }) => r);
  }

  /** Run one subagent to completion and return the tool-result text for the parent. Never throws for child failures. */
  async run(parentSessionId: string, a: { agent: string; task: string; files?: string[]; context?: string; toolCallId?: string }, signal?: AbortSignal): Promise<{ text: string; runId: string; status: SubagentRun["status"] }> {
    const parent = this.sup.get(parentSessionId);
    const depth = (parent.spec.depth ?? 0) + 1;
    const parentAgent = parent.spec.agent ? (await this.o.loadAgents(parent.spec.cwd)).agents.find((x) => x.name === parent.spec.agent) : undefined;
    if (depth > this.o.maxDepth && !(parentAgent?.canSpawn && depth <= 3))
      throw new Error(`subagent depth limit (${this.o.maxDepth}) reached — this agent can't delegate further (set canSpawn: true on its definition to allow)`);

    const { agents } = await this.o.loadAgents(parent.spec.cwd);
    const def = agents.find((x) => x.name.toLowerCase() === a.agent.toLowerCase());
    if (!def) throw new Error(`no agent named "${a.agent}". Available: ${agents.map((x) => x.name).join(", ") || "none — create one in .pi/agents/<name>.md"}`);

    const root = this.rootOf(parentSessionId);
    const run: RunRec = { id: randomUUID(), parentSessionId, toolCallId: a.toolCallId, agent: def.name, task: a.task, status: "queued", depth, turns: 0, progress: [] };
    this.runs.set(run.id, run);
    this.publish(parentSessionId);

    const releases: (() => void)[] = [];
    try {
      releases.push(await this.sem.acquire(signal));
      // file safety: parallel subagents are fine when read-only; only one writer per root at a time
      const writes = !def.tools || def.tools.some((t) => WRITE_TOOLS.has(t));
      if (writes) {
        let w = this.writers.get(root);
        if (!w) this.writers.set(root, (w = new Semaphore(1)));
        releases.push(await w.acquire(signal));
      }
    } catch {
      releases.forEach((r) => r());
      return this.finish(run, "aborted", "cancelled while queued");
    }

    let child: ManagedSession | undefined;
    try {
      const args: string[] = [];
      if (def.model) args.push("--model", def.model);
      if (def.thinking) args.push("--thinking", def.thinking);
      if (def.tools) {
        const bridge = ["notes_read", "notes_append", "message_parent", "ask_parent", ...(def.canSpawn ? ["subagent"] : [])];
        args.push("--tools", [...new Set([...(await this.expandMcp(def.tools, parent.spec.cwd)), ...bridge])].join(","));
      }
      // only the bridge (added for every session) + this agent's allow-listed extensions
      args.push("--no-extensions");
      for (const e of def.extensions ?? []) {
        const path = await this.o.resolveExtension(e, parent.spec.cwd);
        if (!path) throw new Error(`agent "${def.name}" lists unknown extension "${e}"`);
        args.push("-e", path);
      }
      if (def.systemPrompt) args.push("--append-system-prompt", def.systemPrompt);

      run.status = "running";
      run.startedAt = Date.now();
      this.publish(parentSessionId);
      child = await this.sup.create({
        cwd: parent.spec.cwd,
        args,
        name: `${def.name}: ${a.task.slice(0, 48)}`,
        parentId: parentSessionId,
        agent: def.name,
        ephemeral: true,
        depth,
        runId: run.id,
        env: { PI_GUI_RUN_ID: run.id },
      });
      run.sessionId = child.id;
      this.publish(parentSessionId);
      if (child.status === "crashed") throw new Error(`subagent failed to start: ${child.exitInfo?.stderrTail.slice(-500) ?? ""}`);

      const outcome = await this.drive(child, run, def, this.brief(def, a), signal);
      run.transcript = await child.messages().catch(() => []);
      const report = lastAssistantText(run.transcript);
      await child.stop().catch(() => {});
      return this.finish(run, outcome.status, outcome.why, report);
    } catch (e) {
      if (child) await child.stop().catch(() => {});
      return this.finish(run, "failed", (e as Error).message);
    } finally {
      releases.forEach((r) => r());
    }
  }

  private brief(def: AgentDefinition, a: { task: string; files?: string[]; context?: string }) {
    return [
      `You are the "${def.name}" subagent. A parent agent delegated this task to you. You don't have its conversation — read files yourself.`,
      `## Task\n${a.task}`,
      a.files?.length ? `## Relevant files\n${a.files.map((f) => `- ${f}`).join("\n")}` : "",
      a.context ? `## Context from the parent\n${a.context}` : "",
      `## Working with siblings\nOther subagents may run in parallel. Use notes_read to see their findings and notes_append to share yours (short, factual).`,
      `## Final answer\nWhen done, reply with exactly these sections:\n## Summary\n## Files touched\n## Findings\n## Open questions`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Prompt the child and wait until it's truly idle, enforcing turn/time limits and parent abort. */
  private drive(child: ManagedSession, run: RunRec, def: AgentDefinition, brief: string, signal?: AbortSignal): Promise<{ status: SubagentRun["status"]; why?: string }> {
    const proc = child.requireProc();
    const maxTurns = def.maxTurns ?? this.o.defaultMaxTurns ?? 40;
    const timeoutMs = (def.timeoutSec ?? this.o.defaultTimeoutSec ?? 900) * 1000;
    return new Promise((resolve) => {
      let settled = false;
      const done = (status: SubagentRun["status"], why?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off("event", onEvent);
        proc.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
        resolve({ status, why });
      };
      const stopWith = (status: "aborted" | "timeout" | "failed", why: string) => {
        void proc.call({ type: "abort" }, 3000).catch(() => proc.kill());
        done(status, why);
      };
      run.kill = stopWith;
      const onEvent = (e: RpcEvent) => {
        if (e.type === "turn_end") {
          run.turns++;
          this.publish(run.parentSessionId);
          if (run.turns >= maxTurns) stopWith("failed", `turn limit (${maxTurns}) reached`);
        } else if (e.type === "agent_end") {
          // agent_end ends one run only (retries/follow-ups may continue) → confirm idle
          setTimeout(() => {
            proc.getState().then((s) => !s.isStreaming && done("done"), () => {});
          }, 150);
        }
      };
      const onExit = () => done("failed", `subagent process exited: ${child.exitInfo?.stderrTail?.slice(-400) ?? ""}`);
      const onAbort = () => stopWith("aborted", "parent aborted");
      const timer = setTimeout(() => stopWith("timeout", `time limit (${timeoutMs / 1000}s) reached`), timeoutMs);
      proc.on("event", onEvent);
      proc.on("exit", onExit);
      signal?.addEventListener("abort", onAbort);
      proc.prompt(brief).catch((e) => done("failed", (e as Error).message));
    });
  }

  private finish(run: RunRec, status: SubagentRun["status"], why?: string, report?: string) {
    run.status = status;
    run.endedAt = Date.now();
    run.error = status === "done" ? undefined : why;
    run.report = report || undefined;
    run.kill = undefined;
    this.publish(run.parentSessionId);
    const head = `Subagent "${run.agent}" ${status === "done" ? "finished" : status}${why && status !== "done" ? ` (${why})` : ""} after ${run.turns} turn(s).`;
    const progress = run.progress.length ? `\n\nProgress messages:\n${run.progress.map((p) => `- ${p}`).join("\n")}` : "";
    const body = report ? `\n\n${report}` : status === "done" ? "\n\n(no report text)" : "";
    return { text: head + body + progress, runId: run.id, status };
  }

  kill(runId: string) {
    const r = this.runs.get(runId);
    if (!r) throw new Error("unknown run");
    r.kill?.("aborted", "stopped from the GUI");
  }

  transcript(runId: string): AgentMessage[] {
    return this.runs.get(runId)?.transcript ?? [];
  }

  // ---- blackboard ----
  notesFor(sessionId: string): Note[] {
    return this.notes.get(this.rootOf(sessionId)) ?? [];
  }
  appendNote(sessionId: string, text: string): Note {
    const root = this.rootOf(sessionId);
    const author = this.sup.sessions.get(sessionId)?.spec.agent ?? "parent";
    const note: Note = { id: randomUUID(), ts: Date.now(), author, text: text.trim().slice(0, 4000) };
    const list = [...(this.notes.get(root) ?? []), note]; // append-only
    this.notes.set(root, list);
    this.bus.publish(`session:${root}`, { kind: "notes", runId: root, notes: list });
    return note;
  }

  // ---- mid-run channels ----
  messageParent(sessionId: string, text: string) {
    const runId = this.sup.sessions.get(sessionId)?.spec.runId;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) throw new Error("message_parent is only available inside a subagent");
    run.progress.push(text.trim().slice(0, 1000));
    this.publish(run.parentSessionId);
  }

  /** ask_parent: blocks the child until the human supervising the root session answers (or timeout). */
  ask(sessionId: string, text: string, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<string> {
    const s = this.sup.sessions.get(sessionId);
    const q: ParentQuestion = { id: randomUUID(), rootSessionId: this.rootOf(sessionId), runId: s?.spec.runId, from: s?.spec.agent ?? "agent", text, ts: Date.now() };
    return new Promise((resolve) => {
      const finish = (answer: string) => {
        if (!this.questions.has(q.id)) return;
        this.questions.delete(q.id);
        clearTimeout(t);
        this.bus.publish(`session:${q.rootSessionId}`, { kind: "question_done", id: q.id });
        resolve(answer);
      };
      const t = setTimeout(() => finish("(no answer within 10 minutes — proceed with your best judgement and note the assumption)"), timeoutMs);
      signal?.addEventListener("abort", () => finish("(cancelled)"));
      this.questions.set(q.id, { q, resolve: finish });
      this.bus.publish(`session:${q.rootSessionId}`, { kind: "question", question: q });
    });
  }
  answer(id: string, text: string) {
    const q = this.questions.get(id);
    if (!q) throw new Error("question no longer open");
    q.resolve(text);
  }
  openQuestions(rootSessionId: string): ParentQuestion[] {
    return [...this.questions.values()].map((x) => x.q).filter((q) => q.rootSessionId === rootSessionId);
  }
}
