import { randomUUID } from "node:crypto";
import type { AgentMessage, Channel, RpcEvent, SessionInfo, SessionState, SessionStatus } from "@pi-gui/protocol";
import { PiProcess, type PiExitInfo } from "./pi/adapter.ts";
import type { Bus } from "./bus.ts";

export interface SessionSpawnSpec {
  cwd: string;
  /** resume an existing pi session file */
  sessionFile?: string;
  /** extra pi CLI args (model, tools, -e, --append-system-prompt …) */
  args?: string[];
  env?: Record<string, string>;
  name?: string;
  parentId?: string;
  agent?: string;
  /** ephemeral (subagents): don't persist a session file */
  ephemeral?: boolean;
  /** subagent tree: 0 = top-level session */
  depth?: number;
  runId?: string;
}

export interface SupervisorOptions {
  bus: Bus;
  piCommand?: string[];
  /** env injected into every pi (PI_GUI_URL, PI_GUI_TOKEN, …) */
  baseEnv?: () => Record<string, string>;
  /** extra args for every pi (e.g. -e gui-bridge) */
  baseArgs?: () => string[];
  restartOnCrash?: boolean;
  onRemoved?: (id: string) => void;
}

/** A GUI session: stable id, wraps whichever PiProcess currently backs it. */
export class ManagedSession {
  readonly id: string;
  status: SessionStatus = "starting";
  proc?: PiProcess;
  state?: SessionState;
  exitInfo?: SessionInfo["exitInfo"];
  private crashes: number[] = [];
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    readonly spec: SessionSpawnSpec,
    private sup: Supervisor,
    id?: string,
  ) {
    this.id = id ?? randomUUID();
  }

  get channel(): Channel {
    return `session:${this.id}`;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      cwd: this.spec.cwd,
      status: this.status,
      name: this.state?.sessionName ?? this.spec.name,
      sessionFile: this.state?.sessionFile ?? this.spec.sessionFile,
      parentId: this.spec.parentId,
      agent: this.spec.agent,
      exitInfo: this.exitInfo,
    };
  }

  async start(): Promise<void> {
    const o = this.sup.opts;
    const sessionFile = this.state?.sessionFile ?? this.spec.sessionFile;
    const args = [
      ...(o.baseArgs?.() ?? []),
      ...(this.spec.ephemeral ? ["--no-session"] : sessionFile ? ["--session", sessionFile] : []),
      ...(this.spec.args ?? []),
    ];
    const proc = new PiProcess({
      cwd: this.spec.cwd,
      piCommand: o.piCommand,
      args,
      env: { ...(o.baseEnv?.() ?? {}), ...this.spec.env, PI_GUI_SESSION_ID: this.id },
    });
    this.proc = proc;
    this.exitInfo = undefined;
    this.setStatus("starting");

    proc.on("event", (e: RpcEvent) => this.onEvent(e));
    proc.on("stderr", (text: string) => this.sup.opts.bus.publish(this.channel, { kind: "stderr", text }));
    proc.on("exit", (info: PiExitInfo) => this.onExit(proc, info));
    proc.start();

    try {
      await this.refreshState();
      if (this.spec.name && !this.state?.sessionName) {
        await proc.call({ type: "set_session_name", name: this.spec.name }).catch(() => {});
        await this.refreshState();
      }
      if (this.proc === proc && proc.running) this.setStatus(this.state?.isStreaming ? "streaming" : "idle");
    } catch (e) {
      if (proc.running) throw e;
      // exited during startup: onExit already set crashed
    }
  }

  private onEvent(e: RpcEvent): void {
    this.sup.opts.bus.publish(this.channel, { kind: "rpc", record: e });
    switch (e.type) {
      case "agent_start":
        this.setStatus("streaming");
        break;
      case "agent_end":
        // agent_end ends one run only; retries/compaction/follow-ups may continue → ask pi.
        this.scheduleRefresh();
        break;
      case "compaction_end":
      case "auto_retry_end":
        this.scheduleRefresh();
        break;
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshState()
        .then(() => {
          if (this.status === "streaming" || this.status === "idle")
            this.setStatus(this.state?.isStreaming ? "streaming" : "idle");
        })
        .catch(() => {});
    }, 50);
  }

  async refreshState(): Promise<SessionState | undefined> {
    if (!this.proc?.running) return this.state;
    this.state = await this.proc.getState();
    this.sup.opts.bus.publish(this.channel, { kind: "session_state", state: this.state });
    return this.state;
  }

  private onExit(proc: PiProcess, info: PiExitInfo): void {
    if (this.proc !== proc) return; // superseded by restart
    clearTimeout(this.refreshTimer);
    this.exitInfo = { code: info.code, signal: info.signal, stderrTail: info.stderrTail };
    if (info.expected) {
      this.setStatus("stopped");
      return;
    }
    this.setStatus("crashed");
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.sup.opts.restartOnCrash && this.crashes.length <= 3) {
      setTimeout(() => void this.restart().catch(() => {}), 500 * this.crashes.length);
    }
  }

  async restart(): Promise<void> {
    await this.proc?.stop(2000);
    await this.start();
  }

  async stop(): Promise<void> {
    clearTimeout(this.refreshTimer);
    // keep the transcript viewable after the process is gone (finished subagents, stopped sessions)
    if (this.proc?.running) this.lastMessages = await this.messages().catch(() => this.lastMessages);
    await this.proc?.stop();
    this.setStatus("stopped");
  }

  lastMessages: AgentMessage[] = [];
  async messages(): Promise<AgentMessage[]> {
    if (!this.proc?.running) return this.lastMessages;
    this.lastMessages = ((await this.proc.getMessages()).messages ?? []) as AgentMessage[];
    return this.lastMessages;
  }

  requireProc(): PiProcess {
    if (!this.proc?.running) throw new Error(`session ${this.id} is ${this.status}`);
    return this.proc;
  }

  private setStatus(s: SessionStatus): void {
    const changed = this.status !== s;
    this.status = s;
    this.sup.opts.bus.publish(this.channel, { kind: "session_info", info: this.info() });
    if (changed) this.sup.publishList();
  }
}

/** Owns every pi process. The UI is only a view. */
export class Supervisor {
  readonly sessions = new Map<string, ManagedSession>();
  private extraKillers = new Set<() => void>();

  constructor(readonly opts: SupervisorOptions) {}

  async create(spec: SessionSpawnSpec): Promise<ManagedSession> {
    const s = new ManagedSession(spec, this);
    this.sessions.set(s.id, s);
    this.publishList();
    await s.start();
    return s;
  }

  get(id: string): ManagedSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }

  async remove(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.stop();
    this.sessions.delete(id);
    this.opts.bus.drop(s.channel);
    this.opts.onRemoved?.(id);
    // children (subagents) go with their parent
    for (const c of [...this.sessions.values()].filter((x) => x.spec.parentId === id)) await this.remove(c.id);
    this.publishList();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  publishList(): void {
    this.opts.bus.publish("app", { kind: "sessions", sessions: this.list() });
  }

  /** Register non-pi children (PTYs) so app exit kills them too. */
  registerKiller(fn: () => void): () => void {
    this.extraKillers.add(fn);
    return () => this.extraKillers.delete(fn);
  }

  /** Synchronous hard kill of everything — safe to call from process 'exit'. */
  killAll(): void {
    for (const s of this.sessions.values()) s.proc?.kill();
    for (const k of this.extraKillers) {
      try {
        k();
      } catch {
        /* ignore */
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.stop()));
    this.killAll();
  }
}

/** Simple async semaphore (subagent concurrency cap). */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;
  constructor(public limit: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const w = () => resolve();
        this.waiters.push(w);
        signal?.addEventListener("abort", () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error("aborted while queued"));
        });
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get queued() {
    return this.waiters.length;
  }
  get running() {
    return this.active;
  }
}
