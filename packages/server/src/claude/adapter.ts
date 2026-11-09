// Claude Code backend: drives the user's own installed `claude` CLI over its stream-json protocol
// (the same one @anthropic-ai/claude-agent-sdk speaks), so turns run on the user's Claude Code login
// and plan limits instead of an API key. Everything is translated into pi's RPC events and commands,
// so the rest of the GUI doesn't care which agent runs a session.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  ExtensionUiRequest,
  ExtensionUiResponse,
  Model,
  RpcCommand,
  RpcEvent,
  RpcResponse,
  SessionState,
  SessionStats,
  ThinkingLevel,
  ToolResultMessage,
} from "@pi-gui/protocol";
import { JsonlSplitter, encodeJsonl } from "../pi/jsonl.ts";
import { killTree, type PiExitInfo } from "../pi/adapter.ts";
import { CLAUDE_PROVIDER, toPiTool, toolResultContent } from "./transcript.ts";

export { CLAUDE_PROVIDER };
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";

export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const claudeProjectsDir = () => join(claudeConfigDir(), "projects");

/** where Claude Code keeps a session's transcript */
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  const guess = join(claudeProjectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(guess)) return guess;
  // very long paths get shortened by Claude Code — look the id up instead
  try {
    for (const d of readdirSync(claudeProjectsDir())) {
      const f = join(claudeProjectsDir(), d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {
    /* no projects dir yet */
  }
  return guess;
}

export const isClaudeTranscript = (file: string | undefined): boolean => !!file && file.startsWith(claudeProjectsDir() + "/") && file.endsWith(".jsonl");
export const claudeSessionIdOf = (file: string) => file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);

/** The user's `claude` CLI: explicit setting, then PATH, then the installer's usual spots. */
export function findClaudeBinary(explicit?: string): string | undefined {
  const fromEnv = explicit || process.env.PI_GUI_CLAUDE_BIN;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  for (const d of (process.env.PATH ?? "").split(delimiter)) if (d && existsSync(join(d, "claude"))) return join(d, "claude");
  const h = homedir();
  return [join(h, ".local/bin/claude"), join(h, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p));
}

/** Aliases Claude Code always understands — shown before a session has told us its real model list. */
export const CLAUDE_ALIAS_MODELS: Model[] = [
  { id: "opus", name: "Opus", provider: CLAUDE_PROVIDER, reasoning: true },
  { id: "sonnet", name: "Sonnet", provider: CLAUDE_PROVIDER, reasoning: true },
  { id: "haiku", name: "Haiku", provider: CLAUDE_PROVIDER, reasoning: true },
];

/** Claude Code effort levels, shown in the thinking picker */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface ClaudeSpawnOptions {
  cwd: string;
  bin: string;
  /** Claude Code session id to continue */
  resume?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** transcript of a resumed session, already converted */
  history?: AgentMessage[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}
interface Pending {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
type Raw = Record<string, any>;

const STDERR_TAIL = 8 * 1024;
const clone = (m: AssistantMessage): AssistantMessage => ({ ...m, content: m.content.map((c) => ({ ...c })) as AssistantMessage["content"] });

/** One `claude` process for one GUI session. Same surface and events as PiProcess. */
export class ClaudeProcess extends EventEmitter {
  private child?: ChildProcess;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail = "";
  private stopping = false;
  private exited?: Promise<PiExitInfo>;
  private initDone?: Promise<void>;

  sessionId?: string;
  private model?: string;
  private models: ModelInfo[] = [];
  private commands: { name: string; description?: string; argumentHint?: string }[] = [];
  private effort?: string;
  permissionMode: PermissionMode;
  private name?: string;
  private messages: AgentMessage[];
  private streaming = false;
  private compacting?: () => void;

  // in-flight assistant message
  private cur?: AssistantMessage;
  private blocks = new Map<number, { index: number; json?: string; raw?: string }>();
  private toolNames = new Map<string, string>();
  private openTools = new Set<string>();

  // stats
  private tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private contextTokens: number | null = null;
  private contextWindow = 200_000;

  private ui = new Map<string, (r: ExtensionUiResponse) => void>();
  private alwaysAllow = new Set<string>();
  private warnedOverage = false;
  private planUsage?: SessionState["planUsage"];
  private pendingBash: string[] = [];

  constructor(readonly opts: ClaudeSpawnOptions) {
    super();
    this.sessionId = opts.resume;
    this.model = opts.model;
    this.effort = opts.effort;
    this.permissionMode = opts.permissionMode ?? "default";
    this.messages = [...(opts.history ?? [])];
    for (const m of this.messages) if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") this.toolNames.set(c.id, c.name);
  }

  get pid() {
    return this.child?.pid;
  }
  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }
  get sessionFile(): string | undefined {
    return this.sessionId ? claudeTranscriptPath(this.opts.cwd, this.sessionId) : undefined;
  }

  start(): void {
    if (this.child) throw new Error("already started");
    const o = this.opts;
    const args = [
      "--output-format", "stream-json",
      "--verbose",
      "--input-format", "stream-json",
      "--include-partial-messages",
      // tool permission questions come to us as control requests → GUI dialogs
      "--permission-prompt-tool", "stdio",
      ...(o.resume ? ["--resume", o.resume] : []),
      ...(o.model ? ["--model", o.model] : []),
      ...(o.effort ? ["--effort", o.effort] : []),
      ...(o.permissionMode && o.permissionMode !== "default" ? ["--permission-mode", o.permissionMode] : []),
    ];
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...o.env };
    // GUI internals stay out of the agent's environment
    for (const k of ["ELECTRON_RUN_AS_NODE", "PI_GUI_TOKEN", "PI_GUI_URL", "PI_GUI_SESSION_ID", "NODE_OPTIONS"]) delete env[k];
    env.CLAUDE_CODE_ENTRYPOINT ??= "sdk-ts"; // what the Agent SDK identifies itself as
    const child = spawn(o.bin, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.child = child;

    const splitter = new JsonlSplitter((line) => this.onLine(line));
    child.stdout!.on("data", (c: Buffer) => splitter.push(c));
    child.stdout!.on("end", () => splitter.end());
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => {
      this.stderrTail = (this.stderrTail + s).slice(-STDERR_TAIL);
      this.emit("stderr", s);
    });
    child.stdin!.on("error", () => {});

    this.exited = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        const info: PiExitInfo = { code, signal, stderrTail: this.stderrTail, expected: this.stopping };
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`claude exited (code=${code}, signal=${signal})`));
        }
        this.pending.clear();
        if (this.streaming) this.endRun();
        this.emit("exit", info);
        resolve(info);
      };
      child.on("exit", finish);
      child.on("error", (err) => {
        this.stderrTail += `\n[spawn error] ${err.message}`;
        if (child.exitCode === null && child.pid === undefined) finish(null, null);
      });
    });

    this.initDone = this.control({ subtype: "initialize" }, 60_000).then(
      (r) => {
        this.models = Array.isArray(r.models) ? (r.models as ModelInfo[]) : [];
        this.commands = Array.isArray(r.commands) ? (r.commands as typeof this.commands) : [];
      },
      () => {},
    );
  }

  // ---------- wire ----------

  private write(obj: unknown) {
    if (!this.running) throw new Error("claude is not running");
    this.child!.stdin!.write(encodeJsonl(obj));
  }

  private control(request: Raw, timeoutMs = this.opts.requestTimeoutMs ?? 30_000): Promise<Record<string, unknown>> {
    const id = `g${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`claude did not answer ${request.subtype} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id: id, request });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private ev(e: RpcEvent) {
    this.emit("event", e);
  }

  private onLine(line: string) {
    let r: Raw;
    try {
      r = JSON.parse(line);
    } catch {
      this.emit("stderr", `[non-json stdout] ${line}\n`);
      return;
    }
    switch (r.type) {
      case "control_response": {
        const res = r.response ?? {};
        const p = this.pending.get(res.request_id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(res.request_id);
        if (res.subtype === "error") p.reject(new Error(res.error || "claude refused the request"));
        else p.resolve(res.response ?? {});
        return;
      }
      case "control_request":
        void this.onControlRequest(r.request_id, r.request ?? {});
        return;
      case "system":
        return this.onSystem(r);
      case "rate_limit_event":
        return this.onRateLimit(r.rate_limit_info ?? {});
      case "stream_event":
        if (r.parent_tool_use_id) return; // inside a Claude subagent: its card shows the final result
        return this.onStream(r.event ?? {});
      case "assistant":
        if (!r.parent_tool_use_id) this.onAssistant(r.message ?? {}, r.error);
        return;
      case "user":
        if (!r.parent_tool_use_id) this.onUser(r);
        return;
      case "result":
        return this.onResult(r);
    }
  }

  private onSystem(r: Raw) {
    if (r.subtype === "init") {
      const first = !this.sessionId;
      if (r.session_id) this.sessionId = r.session_id;
      if (typeof r.model === "string") this.model = r.model;
      if (r.permissionMode) this.permissionMode = r.permissionMode;
      if (first) this.emit("session_file", this.sessionFile);
    } else if (r.subtype === "compact_boundary") {
      this.finishCompaction();
    }
  }

  private finishCompaction(errorMessage?: string) {
    if (!this.compacting) return;
    this.ev({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, ...(errorMessage ? { errorMessage } : {}) });
    this.compacting();
    this.compacting = undefined;
  }

  private onRateLimit(i: Raw) {
    const pct = (n: unknown) => (typeof n === "number" ? `${Math.round(n * 100)}%` : undefined);
    const w = i.unifiedWindows ?? {};
    const parts = [pct(w.five_hour?.utilization) && `5h ${pct(w.five_hour.utilization)}`, pct(w.seven_day?.utilization) && `week ${pct(w.seven_day.utilization)}`].filter(Boolean);
    const overage = i.isUsingOverage === true || i.overageInUse === true;
    this.planUsage = { text: parts.join(" · ") || "in use", overage, ...(typeof i.resetsAt === "number" ? { resetsAt: i.resetsAt } : {}) };
    if (overage && !this.warnedOverage) {
      this.warnedOverage = true;
      this.notify("warning", "Your Claude plan limit is used up — this session is now drawing on extra usage.");
    }
    if (i.status === "rejected") {
      const at = typeof i.resetsAt === "number" ? ` until ${new Date(i.resetsAt * 1000).toLocaleTimeString()}` : "";
      this.notify("error", `Claude plan limit reached${at}.`);
    }
  }

  private notify(level: "info" | "warning" | "error", message: string) {
    this.ev({ type: "extension_ui_request", id: randomUUID(), method: "notify", notifyType: level, message });
  }

  // ---------- streaming assistant messages ----------

  private onStream(e: Raw) {
    switch (e.type) {
      case "message_start": {
        const m = e.message ?? {};
        if (!this.streaming) this.beginRun();
        this.cur = { role: "assistant", content: [], provider: CLAUDE_PROVIDER, model: m.model, timestamp: Date.now(), usage: this.usageOf(m.usage) };
        this.curApiId = m.id;
        this.blocks.clear();
        this.ev({ type: "message_start", message: clone(this.cur) });
        this.trackContext(m.usage);
        return;
      }
      case "content_block_start": {
        const cur = this.cur;
        const b = e.content_block ?? {};
        if (!cur) return;
        let kind: AssistantMessageEvent["type"] | undefined;
        if (b.type === "text") {
          cur.content.push({ type: "text", text: b.text ?? "" });
          kind = "text_start";
        } else if (b.type === "thinking") {
          cur.content.push({ type: "thinking", thinking: b.thinking ?? "" });
          kind = "thinking_start";
        } else if (b.type === "tool_use" || b.type === "server_tool_use") {
          const t = toPiTool(b.name, {});
          cur.content.push({ type: "toolCall", id: b.id, name: t.name, arguments: {} });
          this.blocks.set(e.index, { index: cur.content.length - 1, json: "", raw: b.name });
          this.update({ type: "toolcall_start", contentIndex: cur.content.length - 1 });
          return;
        } else return;
        this.blocks.set(e.index, { index: cur.content.length - 1 });
        this.update({ type: kind, contentIndex: cur.content.length - 1 } as AssistantMessageEvent);
        return;
      }
      case "content_block_delta": {
        const blk = this.blocks.get(e.index);
        const c = blk && this.cur?.content[blk.index];
        const d = e.delta ?? {};
        if (!blk || !c) return;
        if (d.type === "text_delta" && c.type === "text") {
          c.text += d.text;
          this.update({ type: "text_delta", contentIndex: blk.index, delta: d.text });
        } else if (d.type === "thinking_delta" && c.type === "thinking") {
          c.thinking += d.thinking;
          this.update({ type: "thinking_delta", contentIndex: blk.index, delta: d.thinking });
        } else if (d.type === "input_json_delta" && c.type === "toolCall") {
          blk.json += d.partial_json ?? "";
          this.update({ type: "toolcall_delta", contentIndex: blk.index, delta: d.partial_json ?? "" });
        }
        return;
      }
      case "content_block_stop": {
        const blk = this.blocks.get(e.index);
        const c = blk && this.cur?.content[blk.index];
        if (!blk || !c) return;
        if (c.type === "text") this.update({ type: "text_end", contentIndex: blk.index, content: c.text });
        else if (c.type === "thinking") this.update({ type: "thinking_end", contentIndex: blk.index, content: c.thinking });
        else if (c.type === "toolCall") {
          let input: Raw = {};
          try {
            input = blk.json ? JSON.parse(blk.json) : {};
          } catch {
            /* keep {} */
          }
          const t = toPiTool(blk.raw ?? c.name, input);
          c.name = t.name;
          c.arguments = t.args;
          this.toolNames.set(c.id, c.name);
          this.update({ type: "toolcall_end", contentIndex: blk.index, toolCall: { ...c } });
          this.openTools.add(c.id);
          this.ev({ type: "tool_execution_start", toolCallId: c.id, toolName: c.name, args: c.arguments });
        }
        return;
      }
      case "message_delta": {
        if (!this.cur) return;
        const sr = e.delta?.stop_reason;
        if (sr) this.cur.stopReason = sr === "tool_use" ? "toolUse" : sr === "max_tokens" ? "length" : sr === "refusal" ? "error" : "stop";
        if (e.usage) {
          this.cur.usage = this.usageOf(e.usage);
          this.trackContext(e.usage);
        }
        return;
      }
      case "message_stop": {
        const m = this.cur;
        if (!m) return;
        this.cur = undefined;
        this.finished.add(this.curApiId ?? "");
        this.addTokens(m.usage);
        this.messages.push(m);
        this.ev({ type: "message_end", message: m });
        return;
      }
    }
  }

  private curApiId?: string;
  private finished = new Set<string>();

  private update(assistantMessageEvent: AssistantMessageEvent) {
    if (this.cur) this.ev({ type: "message_update", message: clone(this.cur), assistantMessageEvent });
  }

  private usageOf(u: Raw | undefined): AssistantMessage["usage"] {
    if (!u) return undefined;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
  }
  private trackContext(u: Raw | undefined) {
    if (!u) return;
    this.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  private addTokens(u: AssistantMessage["usage"]) {
    if (!u) return;
    this.tokens.input += u.input;
    this.tokens.output += u.output;
    this.tokens.cacheRead += u.cacheRead;
    this.tokens.cacheWrite += u.cacheWrite;
  }

  /** whole assistant messages: only needed for ones that weren't streamed (API errors, synthetic replies) */
  private onAssistant(m: Raw, error?: string) {
    if (!m.id || this.finished.has(m.id) || m.id === this.curApiId) return;
    const content: AssistantMessage["content"] = [];
    for (const b of m.content ?? []) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "thinking") content.push({ type: "thinking", thinking: b.thinking });
    }
    if (!content.length && !error) return;
    this.finished.add(m.id);
    if (!this.streaming) this.beginRun();
    const msg: AssistantMessage = {
      role: "assistant",
      content,
      provider: CLAUDE_PROVIDER,
      model: m.model,
      timestamp: Date.now(),
      ...(error ? { stopReason: "error" as const, errorMessage: content.map((c) => (c.type === "text" ? c.text : "")).join("") || error } : {}),
    };
    this.messages.push(msg);
    this.ev({ type: "message_start", message: msg });
    this.ev({ type: "message_end", message: msg });
  }

  private onUser(r: Raw) {
    const content = r.message?.content;
    if (typeof content === "string") {
      const out = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim();
      if (out) this.notify("info", out);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== "tool_result") continue;
      const name = this.toolNames.get(b.tool_use_id) ?? "tool";
      const res: ToolResultMessage = {
        role: "toolResult",
        toolCallId: b.tool_use_id,
        toolName: name,
        content: toolResultContent(b.content),
        isError: !!b.is_error,
        timestamp: Date.now(),
      };
      this.openTools.delete(b.tool_use_id);
      this.ev({ type: "tool_execution_end", toolCallId: b.tool_use_id, toolName: name, result: { content: res.content }, isError: res.isError });
      this.messages.push(res);
      this.ev({ type: "message_start", message: res });
      this.ev({ type: "message_end", message: res });
    }
  }

  private onResult(r: Raw) {
    for (const mu of Object.values((r.modelUsage ?? {}) as Record<string, Raw>)) if (typeof mu.contextWindow === "number") this.contextWindow = mu.contextWindow;
    if (r.is_error || (r.subtype && r.subtype !== "success")) {
      const msg = typeof r.result === "string" && r.result ? r.result : Array.isArray(r.errors) && r.errors.length ? r.errors.join("\n") : "";
      // an interrupt ends with an error result too — not worth a red banner
      if (msg && !/interrupt|abort/i.test(msg)) this.notify("error", msg);
    }
    this.finishCompaction();
    this.endRun();
  }

  private beginRun() {
    this.streaming = true;
    this.ev({ type: "agent_start" });
  }

  private endRun() {
    if (this.cur) {
      const m = { ...this.cur, stopReason: "aborted" as const };
      this.cur = undefined;
      this.messages.push(m);
      this.ev({ type: "message_end", message: m });
    }
    for (const id of this.openTools) {
      const name = this.toolNames.get(id) ?? "tool";
      this.ev({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: "(interrupted)" }] }, isError: true });
    }
    this.openTools.clear();
    if (!this.streaming) return;
    this.streaming = false;
    this.ev({ type: "agent_end", messages: this.messages });
  }

  // ---------- tool permissions & questions → GUI dialogs ----------

  private ask(req: Omit<ExtensionUiRequest, "type" | "id">): Promise<ExtensionUiResponse> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.ui.set(id, resolve);
      this.ev({ type: "extension_ui_request", id, ...req } as ExtensionUiRequest);
    });
  }

  respondUi(resp: ExtensionUiResponse): void {
    const f = this.ui.get(resp.id);
    if (!f) return;
    this.ui.delete(resp.id);
    f(resp);
  }

  private reply(requestId: string, response: Raw) {
    try {
      this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    } catch {
      /* exited */
    }
  }

  private async onControlRequest(requestId: string, req: Raw) {
    if (req.subtype !== "can_use_tool") {
      try {
        this.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `pi-gui does not handle ${req.subtype}` } });
      } catch {
        /* exited */
      }
      return;
    }
    const tool = String(req.tool_name ?? "");
    const input = (req.input ?? {}) as Raw;
    const allow = (updatedInput: Raw = input) => this.reply(requestId, { behavior: "allow", updatedInput });
    const deny = (message: string) => this.reply(requestId, { behavior: "deny", message });

    if (tool === "AskUserQuestion" && Array.isArray(input.questions)) {
      const answers: Record<string, string> = {};
      for (const q of input.questions as Raw[]) {
        const opts = ((q.options ?? []) as Raw[]).map((o) => String(o.label));
        const r = await this.ask({ method: "select", title: String(q.question ?? q.header ?? "Question"), options: [...opts, "Other…"] });
        if (!("value" in r)) return deny("The user dismissed the question.");
        let value = r.value;
        if (value === "Other…") {
          const t = await this.ask({ method: "input", title: String(q.question ?? "Your answer") });
          if (!("value" in t) || !t.value.trim()) return deny("The user dismissed the question.");
          value = t.value;
        }
        answers[String(q.question)] = value;
      }
      return allow({ ...input, answers });
    }
    if (tool === "ExitPlanMode") {
      const r = await this.ask({ method: "confirm", title: "Claude's plan is ready — start implementing?", message: typeof input.plan === "string" ? input.plan.slice(0, 4000) : undefined });
      if ("confirmed" in r && r.confirmed) {
        this.permissionMode = "default";
        return allow();
      }
      return deny("The user wants to keep planning. Ask what to change.");
    }

    if (this.alwaysAllow.has(tool)) return allow();
    const t = toPiTool(tool, input);
    const what =
      typeof t.args.command === "string" ? t.args.command : typeof t.args.path === "string" ? t.args.path : typeof t.args.pattern === "string" ? t.args.pattern : JSON.stringify(input).slice(0, 300);
    const always = `Always allow ${tool} in this session`;
    const r = await this.ask({
      method: "select",
      title: `Allow Claude to use ${tool}?`,
      message: [what, req.decision_reason].filter(Boolean).join("\n\n"),
      options: ["Allow", always, "Deny"],
    });
    if (!("value" in r) || r.value === "Deny") return deny("The user denied this tool call.");
    if (r.value === always) this.alwaysAllow.add(tool);
    allow();
  }

  // ---------- pi command surface ----------

  private modelInfo(): Model | null {
    if (!this.model) return null;
    const m = this.models.find((x) => x.value === this.model || x.resolvedModel === this.model);
    return this.toModel(m ?? { value: this.model, displayName: this.model, supportsEffort: true });
  }
  private toModel(m: ModelInfo): Model {
    return {
      id: m.value,
      name: m.displayName || m.value,
      provider: CLAUDE_PROVIDER,
      reasoning: m.supportsEffort !== false,
      thinkingLevels: m.supportedEffortLevels?.length ? m.supportedEffortLevels : CLAUDE_EFFORTS,
      contextWindow: this.contextWindow,
    };
  }

  private state(): SessionState & { permissionMode: PermissionMode; backend: "claude" } {
    return {
      model: this.modelInfo(),
      thinkingLevel: (this.effort ?? "") as ThinkingLevel,
      isStreaming: this.streaming,
      isCompacting: !!this.compacting,
      steeringMode: "all",
      followUpMode: "all",
      sessionFile: this.sessionFile,
      sessionId: this.sessionId ?? "",
      sessionName: this.name,
      autoCompactionEnabled: true,
      messageCount: this.messages.length,
      pendingMessageCount: 0,
      permissionMode: this.permissionMode,
      planUsage: this.planUsage,
      backend: "claude",
    };
  }

  private sendUser(text: string) {
    if (this.pendingBash.length) {
      text = `${this.pendingBash.join("\n\n")}\n\n${text}`;
      this.pendingBash = [];
    }
    if (!this.streaming) this.beginRun();
    const m: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
    this.messages.push(m);
    this.ev({ type: "message_start", message: m });
    this.ev({ type: "message_end", message: m });
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: this.sessionId ?? "" });
  }

  async call<T = unknown>(cmd: RpcCommand, _timeoutMs?: number): Promise<T> {
    return (await this.handle(cmd)) as T;
  }

  async send(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
    try {
      return { type: "response", command: cmd.type, success: true, data: await this.call(cmd, timeoutMs) };
    } catch (e) {
      return { type: "response", command: cmd.type, success: false, error: (e as Error).message };
    }
  }

  private async handle(cmd: RpcCommand): Promise<unknown> {
    switch (cmd.type) {
      case "prompt":
      case "steer":
      case "follow_up":
        // Claude Code queues a message sent mid-turn and reads it as soon as it can
        this.sendUser(cmd.message);
        return;
      case "abort":
        if (!this.streaming) return;
        await this.control({ subtype: "interrupt" }, 5000);
        // the interrupted turn's result normally follows; don't leave the GUI spinning if it doesn't
        setTimeout(() => this.streaming && this.endRun(), 3000);
        return;
      case "get_state":
        await this.initDone;
        return this.state();
      case "get_messages":
        return { messages: this.messages };
      case "get_available_models":
        await this.initDone;
        return { models: this.models.length ? this.models.map((m) => this.toModel(m)) : CLAUDE_ALIAS_MODELS };
      case "set_model": {
        const r = await this.control({ subtype: "set_model", model: cmd.modelId });
        this.model = typeof r.model === "string" ? cmd.modelId : cmd.modelId;
        return this.modelInfo();
      }
      case "set_thinking_level":
        await this.control({ subtype: "apply_flag_settings", settings: { effortLevel: cmd.level } });
        this.effort = cmd.level;
        return;
      case "get_session_stats": {
        const t = this.tokens;
        const stats: SessionStats = {
          sessionFile: this.sessionFile,
          sessionId: this.sessionId ?? "",
          tokens: { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite },
          cost: 0, // runs on the plan, not per-token billing
          contextUsage: { tokens: this.contextTokens, contextWindow: this.contextWindow, percent: this.contextTokens == null ? null : (this.contextTokens / this.contextWindow) * 100 },
        };
        return stats;
      }
      case "set_session_name": {
        this.name = cmd.name;
        const f = this.sessionFile;
        if (f && existsSync(f)) await appendFile(f, JSON.stringify({ type: "custom-title", customTitle: cmd.name, sessionId: this.sessionId }) + "\n").catch(() => {});
        return;
      }
      case "get_commands":
        await this.initDone;
        return { commands: this.commands.map((c) => ({ name: c.name, description: c.description, source: "claude-code" })) };
      case "compact": {
        if (this.streaming) throw new Error("wait for Claude to finish first");
        this.ev({ type: "compaction_start", reason: "manual" });
        const done = new Promise<void>((resolve) => (this.compacting = resolve));
        this.write({ type: "user", message: { role: "user", content: [{ type: "text", text: cmd.customInstructions ? `/compact ${cmd.customInstructions}` : "/compact" }] }, parent_tool_use_id: null, session_id: this.sessionId ?? "" });
        await done;
        return;
      }
      case "bash":
        return this.runBash(cmd.command);
      case "abort_bash":
        this.bashChild && killTree(this.bashChild, "SIGTERM");
        return;
      default:
        throw new Error(`not available in Claude Code sessions (${cmd.type})`);
    }
  }

  private bashChild?: ChildProcess;
  /** `!cmd` from the composer: run it here, hand the output to Claude with the next message (as pi does) */
  private runBash(command: string): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
    return new Promise((resolve) => {
      const c = spawn(process.env.SHELL || "/bin/bash", ["-c", command], { cwd: this.opts.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      this.bashChild = c;
      let out = "";
      const add = (d: Buffer) => (out = (out + d.toString("utf8")).slice(-200_000));
      c.stdout!.on("data", add);
      c.stderr!.on("data", add);
      const done = (code: number | null) => {
        this.bashChild = undefined;
        const truncated = out.length > 30_000;
        const shown = truncated ? out.slice(-30_000) : out;
        this.pendingBash.push(`I ran \`${command}\` (exit ${code ?? "?"}):\n\`\`\`\n${shown.trimEnd()}\n\`\`\``);
        resolve({ output: shown, exitCode: code, truncated });
      };
      c.on("exit", done);
      c.on("error", (e) => ((out += e.message), done(null)));
    });
  }

  // typed helpers, same as PiProcess
  prompt(message: string, _streamingBehavior?: "steer" | "followUp") {
    return this.call({ type: "prompt", message });
  }
  steer(message: string) {
    return this.call({ type: "steer", message });
  }
  followUp(message: string) {
    return this.call({ type: "follow_up", message });
  }
  abort() {
    return this.call({ type: "abort" });
  }
  getState() {
    return this.call<SessionState>({ type: "get_state" });
  }
  getMessages() {
    return this.call<{ messages: unknown[] }>({ type: "get_messages" });
  }
  getModels() {
    return this.call<{ models: Model[] }>({ type: "get_available_models" });
  }
  setModel(_provider: string, modelId: string) {
    return this.call<Model>({ type: "set_model", provider: CLAUDE_PROVIDER, modelId });
  }
  setThinking(level: ThinkingLevel) {
    return this.call({ type: "set_thinking_level", level });
  }
  getStats() {
    return this.call<SessionStats>({ type: "get_session_stats" });
  }
  async setPermissionMode(mode: PermissionMode) {
    await this.control({ subtype: "set_permission_mode", mode });
    this.permissionMode = mode;
  }

  async stop(graceMs = 3000): Promise<PiExitInfo | undefined> {
    if (!this.child || !this.exited) return undefined;
    this.stopping = true;
    for (const [id, f] of this.ui) f({ type: "extension_ui_response", id, cancelled: true });
    this.ui.clear();
    if (this.running) {
      try {
        this.child.stdin!.end(); // lets claude flush its transcript and exit by itself
      } catch {
        /* closed */
      }
      const t1 = setTimeout(() => this.child && killTree(this.child, "SIGTERM"), 500);
      const t2 = setTimeout(() => this.child && killTree(this.child, "SIGKILL"), graceMs);
      const info = await this.exited;
      clearTimeout(t1);
      clearTimeout(t2);
      return info;
    }
    return this.exited;
  }

  kill(): void {
    if (this.child && this.running) {
      this.stopping = true;
      killTree(this.child, "SIGKILL");
    }
  }

  waitForExit(): Promise<PiExitInfo> {
    if (!this.exited) throw new Error("not started");
    return this.exited;
  }
}
