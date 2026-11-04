import type { Channel, ChannelEvent, ClientMessage, ServerMessage } from "@pi-gui/protocol";

type Handler = (e: ChannelEvent, seq: number) => void;
type ResetHandler = () => void;

function readToken(): string {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) {
    try {
      sessionStorage.setItem("pi-gui-token", m[1]!);
    } catch {
      /* private mode */
    }
    // keep the token out of history/screenshots; preserve other hash params (page=…)
    const rest = location.hash.replace(/^#/, "").split("&").filter((x) => x && !x.startsWith("token=")).join("&");
    history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
    return m[1]!;
  }
  try {
    return sessionStorage.getItem("pi-gui-token") ?? "";
  } catch {
    return "";
  }
}

/**
 * Single multiplexed socket with auto-reconnect. Tracks the last seq per channel so
 * re-subscribing after a reconnect only replays what was missed.
 */
class Connection {
  readonly token = readToken();
  private ws?: WebSocket;
  private n = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<Channel, Set<Handler>>();
  private resetHandlers = new Map<Channel, Set<ResetHandler>>();
  private lastSeq = new Map<Channel, number>();
  private queue: string[] = [];
  private statusListeners = new Set<(s: ConnStatus) => void>();
  status: ConnStatus = "connecting";
  private backoff = 250;

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 250;
      this.setStatus("open");
      for (const ch of this.handlers.keys()) this.raw({ t: "sub", ch, since: this.lastSeq.get(ch) });
      for (const q of this.queue.splice(0)) ws.send(q);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string) as ServerMessage);
    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new Error("connection lost"));
      this.pending.clear();
      this.setStatus(this.token ? "closed" : "no-token");
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  private onMessage(m: ServerMessage) {
    if (m.t === "res") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      if (m.ok) p.resolve(m.data);
      else p.reject(new Error(m.error));
    } else if (m.t === "evt") {
      const last = this.lastSeq.get(m.ch) ?? 0;
      if (m.seq <= last) return; // duplicate after replay
      this.lastSeq.set(m.ch, m.seq);
      for (const h of this.handlers.get(m.ch) ?? []) h(m.data, m.seq);
    } else if (m.t === "reset") {
      this.lastSeq.delete(m.ch);
      for (const h of this.resetHandlers.get(m.ch) ?? []) h();
    }
  }

  private raw(m: ClientMessage) {
    const s = JSON.stringify(m);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (m.t !== "pty_in" && m.t !== "pty_resize") this.queue.push(s);
  }

  req<T = any>(op: string, args?: unknown): Promise<T> {
    const id = `c${++this.n}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.raw({ t: "req", id, op, args });
    });
  }

  /**
   * Subscribe to a channel. `since` = seq the caller already has (e.g. from a snapshot).
   * onReset fires when the server can't replay from `since` — caller should re-snapshot.
   */
  sub(ch: Channel, h: Handler, opts: { since?: number; onReset?: ResetHandler } = {}): () => void {
    let set = this.handlers.get(ch);
    const first = !set;
    if (!set) this.handlers.set(ch, (set = new Set()));
    set.add(h);
    if (opts.onReset) {
      if (!this.resetHandlers.has(ch)) this.resetHandlers.set(ch, new Set());
      this.resetHandlers.get(ch)!.add(opts.onReset);
    }
    if (opts.since !== undefined) this.lastSeq.set(ch, opts.since);
    if (first) this.raw({ t: "sub", ch, since: this.lastSeq.get(ch) });
    return () => {
      set!.delete(h);
      if (opts.onReset) this.resetHandlers.get(ch)?.delete(opts.onReset);
      if (set!.size === 0) {
        this.handlers.delete(ch);
        this.lastSeq.delete(ch);
        this.raw({ t: "unsub", ch });
      }
    };
  }

  send(m: ClientMessage) {
    this.raw(m);
  }

  onStatus(l: (s: ConnStatus) => void) {
    this.statusListeners.add(l);
    l(this.status);
    return () => this.statusListeners.delete(l);
  }
  private setStatus(s: ConnStatus) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }
}

export type ConnStatus = "connecting" | "open" | "closed" | "no-token";
export const conn = new Connection();
