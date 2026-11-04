import { execFileSync, spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TerminalInfo, TerminalStatus } from "@pi-gui/protocol";
import type { Bus } from "../bus.ts";

// ---- node-pty loading (with plain-spawn fallback for locked-down machines) ----
type IPty = import("node-pty").IPty;
type NodePty = typeof import("node-pty");
let nodePty: NodePty | null | undefined;
export let ptyLoadError: string | undefined;

/** node-pty's prebuilt spawn-helper ships without +x (posix_spawnp failed) — fix it once. */
function fixSpawnHelper(pkgDir: string) {
  const pre = join(pkgDir, "prebuilds");
  if (!existsSync(pre)) return;
  for (const d of readdirSync(pre)) {
    const helper = join(pre, d, "spawn-helper");
    try {
      if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    } catch {
      /* read-only install: spawn will report the error */
    }
  }
}

export function loadPty(): NodePty | null {
  if (nodePty !== undefined) return nodePty;
  try {
    const require = createRequire(import.meta.url);
    const main = require.resolve("node-pty");
    fixSpawnHelper(dirname(dirname(main)));
    nodePty = require("node-pty") as NodePty;
  } catch (e) {
    ptyLoadError = (e as Error).message;
    nodePty = null;
  }
  return nodePty;
}

// ---- one terminal process ----
export interface TermSpec {
  id?: string;
  name: string;
  cwd: string; // already resolved + validated
  command?: string; // undefined → interactive login shell
  env?: Record<string, string>;
  port?: number;
  profile: boolean;
  project?: string;
  restartOnExit?: boolean;
}

interface Proc {
  pid: number;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(sig: NodeJS.Signals): void;
}

const MAX_RESTARTS_PER_MIN = 5;

export class Terminal {
  readonly id: string;
  status: TerminalStatus = "stopped";
  exitCode?: number | null;
  error?: string;
  private proc?: Proc;
  private cols = 120;
  private rows = 30;
  private outBuf = "";
  private flushTimer?: NodeJS.Timeout;
  private userStopped = false;
  private restarts: number[] = [];
  private exitWaiters: (() => void)[] = [];
  /** plain-text tail for terminal_read (ANSI stripped lazily) */
  private tail: string[] = [""];

  constructor(
    public spec: TermSpec,
    private mgr: PtyManager,
  ) {
    this.id = spec.id ?? randomUUID();
  }

  get channel() {
    return `terminal:${this.id}` as const;
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      name: this.spec.name,
      cwd: this.spec.cwd,
      command: this.spec.command ?? "(shell)",
      status: this.status,
      exitCode: this.exitCode,
      error: this.error,
      profile: this.spec.profile,
      port: this.spec.port,
    };
  }

  start(): void {
    if (this.status === "running") return;
    this.userStopped = false;
    this.error = undefined;
    this.exitCode = undefined;
    if (!existsSync(this.spec.cwd) || !statSync(this.spec.cwd).isDirectory()) {
      this.fail(`working directory does not exist: ${this.spec.cwd}`);
      return;
    }
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    // login shell so nvm / Homebrew / .zshrc PATH are loaded
    const args =
      process.platform === "win32"
        ? this.spec.command
          ? ["-NoLogo", "-Command", this.spec.command]
          : ["-NoLogo"]
        : this.spec.command
          ? ["-l", "-i", "-c", this.spec.command]
          : ["-l", "-i"];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
      ...this.spec.env,
    };
    // never leak the GUI's credentials into user terminals
    delete env.PI_GUI_TOKEN;
    delete env.PI_GUI_TOKEN_OVERRIDE;
    delete env.ELECTRON_RUN_AS_NODE; // set for pi children inside the app; would break Electron apps run here
    delete env.PI_GUI_SESSION_ID;

    try {
      this.proc = this.mgr.pty ? this.spawnPty(shell, args, env) : this.spawnPlain(shell, args, env);
    } catch (e) {
      this.fail(`failed to start: ${(e as Error).message}`);
      return;
    }
    this.setStatus("running");
    if (!this.mgr.pty) this.emit(`\x1b[33m[pi-gui] node-pty unavailable (${ptyLoadError}); running without a TTY — interactive keys won't work.\x1b[0m\r\n`);
  }

  private spawnPty(shell: string, args: string[], env: Record<string, string>): Proc {
    const p: IPty = this.mgr.pty!.spawn(shell, args, { name: "xterm-256color", cols: this.cols, rows: this.rows, cwd: this.spec.cwd, env });
    p.onData((d) => this.emit(d));
    p.onExit(({ exitCode }) => this.onExit(exitCode));
    return {
      pid: p.pid,
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      // node-pty children are session leaders (setsid) → pgid == pid, so -pid hits the whole tree (Metro's watchers etc.)
      kill: (sig) => killGroup(p.pid, sig, () => p.kill(sig)),
    };
  }

  private spawnPlain(shell: string, args: string[], env: Record<string, string>): Proc {
    const c: ChildProcess = cpSpawn(shell, args, { cwd: this.spec.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    c.stdout!.setEncoding("utf8");
    c.stderr!.setEncoding("utf8");
    c.stdout!.on("data", (d: string) => this.emit(d.replace(/\r?\n/g, "\r\n")));
    c.stderr!.on("data", (d: string) => this.emit(d.replace(/\r?\n/g, "\r\n")));
    c.on("exit", (code) => this.onExit(code ?? null));
    c.on("error", (e) => this.emit(`\r\n[spawn error] ${e.message}\r\n`));
    return {
      pid: c.pid ?? -1,
      write: (d) => c.stdin!.write(d.replace(/\r/g, "\n")),
      resize: () => {},
      kill: (sig) => killGroup(c.pid ?? -1, sig, () => c.kill(sig)),
    };
  }

  private emit(d: string) {
    this.appendTail(d);
    this.outBuf += d;
    // coalesce bursts (Metro's bundling progress) into ~60fps frames
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 16);
  }
  private flush() {
    this.flushTimer = undefined;
    if (!this.outBuf) return;
    const data = this.outBuf;
    this.outBuf = "";
    this.mgr.bus.publish(this.channel, { kind: "pty_out", data });
  }

  private appendTail(d: string) {
    const parts = d.split("\n");
    this.tail[this.tail.length - 1] = (this.tail.at(-1) ?? "") + (parts[0] ?? "");
    for (let i = 1; i < parts.length; i++) this.tail.push(parts[i]!);
    if (this.tail.length > 2000) this.tail.splice(0, this.tail.length - 2000);
  }

  /** Last n lines as plain text (ANSI + CR overwrite handled). Read-only. */
  readLines(n: number): string[] {
    return this.tail
      .slice(-n - 1)
      .map((l) => {
        const s = stripAnsi(l);
        const cr = s.lastIndexOf("\r", s.length - 2); // progress bars overwrite with \r
        return (cr >= 0 ? s.slice(cr + 1) : s).replace(/\r$/, "");
      })
      .reduceRight<string[]>((acc, l) => (acc.length === 0 && l.trim() === "" ? acc : [l, ...acc]), []) // drop trailing blanks
      .slice(-n);
  }

  private onExit(code: number | null) {
    this.flush();
    this.proc = undefined;
    this.exitCode = code;
    this.emit(`\r\n\x1b[2m[process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`);
    this.flush();
    this.setStatus(this.userStopped ? "stopped" : "exited");
    for (const w of this.exitWaiters.splice(0)) w();
    if (!this.userStopped && this.spec.restartOnExit) {
      const now = Date.now();
      this.restarts = [...this.restarts.filter((t) => now - t < 60_000), now];
      if (this.restarts.length <= MAX_RESTARTS_PER_MIN) setTimeout(() => !this.userStopped && this.start(), 1000);
      else this.emit(`\x1b[31m[pi-gui] restarted ${MAX_RESTARTS_PER_MIN}× in a minute — giving up.\x1b[0m\r\n`);
    }
  }

  write(d: string) {
    this.proc?.write(d);
  }

  resize(cols: number, rows: number) {
    if (!(cols > 0 && rows > 0)) return;
    this.cols = Math.floor(cols);
    this.rows = Math.floor(rows);
    try {
      this.proc?.resize(this.cols, this.rows);
    } catch {
      /* exited */
    }
  }

  /** SIGTERM the process group (Ctrl-C equivalent), SIGKILL after grace. */
  async stop(graceMs = 3000): Promise<void> {
    this.userStopped = true;
    const p = this.proc;
    if (!p) {
      if (this.status !== "error") this.setStatus("stopped");
      return;
    }
    const exited = new Promise<void>((r) => this.exitWaiters.push(r));
    p.kill("SIGTERM");
    const t = setTimeout(() => p.kill("SIGKILL"), graceMs);
    await exited;
    clearTimeout(t);
  }

  hardKill() {
    this.userStopped = true;
    this.proc?.kill("SIGKILL");
  }

  async restart() {
    await this.stop();
    this.start();
  }

  private fail(msg: string) {
    this.error = msg;
    this.emit(`\x1b[31m[pi-gui] ${msg}\x1b[0m\r\n`);
    this.flush();
    this.setStatus("error");
  }

  private setStatus(s: TerminalStatus) {
    this.status = s;
    this.mgr.bus.publish(this.channel, { kind: "terminal_info", info: this.info() });
    this.mgr.publishList();
  }
}

/**
 * Kill everything a terminal started. An interactive shell (-i, needed so .zshrc/nvm load)
 * enables job control, which puts each command in its *own* process group, so `kill -pgid`
 * alone misses Metro. We collect: every process on the pty's controlling tty (covers job-control
 * groups and orphans reparented to launchd) ∪ the descendant tree by ppid, then signal them all.
 * Must be called while the shell is still alive (its tty is looked up from its pid).
 */
export function terminalProcesses(pid: number): number[] {
  const pids = new Set<number>([pid]);
  try {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (tty && tty !== "??") {
      for (const l of execFileSync("pgrep", ["-t", tty], { encoding: "utf8" }).split("\n")) {
        const p = Number(l.trim());
        if (p > 0) pids.add(p);
      }
    }
  } catch {
    /* pgrep exits 1 when nothing matches; process may be gone */
  }
  try {
    const children = new Map<number, number[]>();
    for (const l of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
      const [c, pp] = l.trim().split(/\s+/).map(Number);
      if (c && pp) children.set(pp, [...(children.get(pp) ?? []), c]);
    }
    const stack = [...pids];
    while (stack.length) for (const c of children.get(stack.pop()!) ?? []) if (!pids.has(c)) pids.add(c), stack.push(c);
  } catch {
    /* ignore */
  }
  pids.delete(process.pid); // never ourselves
  return [...pids];
}

function killGroup(pid: number, sig: NodeJS.Signals, fallback: () => void) {
  if (pid <= 0) return;
  if (process.platform === "win32") {
    cpSpawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  const targets = terminalProcesses(pid);
  let any = false;
  for (const p of targets) {
    try {
      process.kill(p, sig);
      any = true;
    } catch {
      /* gone */
    }
  }
  try {
    process.kill(-pid, sig);
  } catch {
    if (!any) {
      try {
        fallback();
      } catch {
        /* gone */
      }
    }
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

// ---- manager ----
export class PtyManager {
  readonly terminals = new Map<string, Terminal>();
  readonly pty: NodePty | null;

  constructor(readonly bus: Bus) {
    this.pty = loadPty();
  }

  /** Start (or return the existing) terminal for a spec. Profile terminals have stable ids. */
  open(spec: TermSpec): Terminal {
    if (spec.id) {
      const existing = this.terminals.get(spec.id);
      if (existing) {
        existing.spec = { ...spec };
        if (existing.status !== "running") existing.start();
        return existing;
      }
    }
    const t = new Terminal(spec, this);
    this.terminals.set(t.id, t);
    t.start();
    return t;
  }

  get(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`unknown terminal ${id}`);
    return t;
  }

  async remove(id: string) {
    const t = this.terminals.get(id);
    if (!t) return;
    await t.stop();
    this.terminals.delete(id);
    this.bus.drop(t.channel);
    this.publishList();
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => t.info());
  }

  findByName(name: string): Terminal | undefined {
    const n = name.toLowerCase();
    return [...this.terminals.values()].find((t) => t.spec.name.toLowerCase() === n);
  }

  publishList() {
    this.bus.publish("app", { kind: "terminals", terminals: this.list() });
  }

  killAll() {
    for (const t of this.terminals.values()) t.hardKill();
  }

  async stopAll() {
    await Promise.allSettled([...this.terminals.values()].map((t) => t.stop(1500)));
  }
}
