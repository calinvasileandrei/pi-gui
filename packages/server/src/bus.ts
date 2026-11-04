import type { Channel, ChannelEvent } from "@pi-gui/protocol";

export interface BusEntry {
  seq: number;
  data: ChannelEvent;
}
type Listener = (ch: Channel, e: BusEntry) => void;

interface Ring {
  seq: number;
  entries: BusEntry[];
  bytes: number;
}

export interface BusLimits {
  maxEntries: number;
  maxBytes: number;
}

const sizeOf = (e: ChannelEvent): number =>
  e.kind === "pty_out" ? e.data.length : e.kind === "rpc" ? 512 : 128; // rough; avoids stringify on hot path

/**
 * In-memory pub/sub with a ring buffer per channel, so a reconnecting UI can replay
 * what it missed (`since`). Channels are created lazily.
 */
export class Bus {
  private rings = new Map<Channel, Ring>();
  private listeners = new Set<Listener>();

  constructor(private limits: (ch: Channel) => BusLimits = defaultLimits) {}

  publish(ch: Channel, data: ChannelEvent): BusEntry {
    let r = this.rings.get(ch);
    if (!r) this.rings.set(ch, (r = { seq: 0, entries: [], bytes: 0 }));
    const entry = { seq: ++r.seq, data };
    r.entries.push(entry);
    r.bytes += sizeOf(data);
    const { maxEntries, maxBytes } = this.limits(ch);
    while (r.entries.length > 1 && (r.entries.length > maxEntries || r.bytes > maxBytes)) {
      r.bytes -= sizeOf(r.entries.shift()!.data);
    }
    for (const l of this.listeners) l(ch, entry);
    return entry;
  }

  /** Current head seq of a channel (0 if nothing published). */
  head(ch: Channel): number {
    return this.rings.get(ch)?.seq ?? 0;
  }

  /**
   * Entries with seq > since. Returns null when the buffer no longer reaches back to `since`
   * (client must re-snapshot). `since` undefined → everything buffered.
   */
  replay(ch: Channel, since?: number): BusEntry[] | null {
    const r = this.rings.get(ch);
    if (!r) return since && since > 0 ? null : [];
    if (since === undefined) return [...r.entries];
    if (since > r.seq) return null; // server restarted / seq reset
    const first = r.entries[0]?.seq ?? r.seq + 1;
    if (since < first - 1) return null;
    return r.entries.filter((e) => e.seq > since);
  }

  drop(ch: Channel): void {
    this.rings.delete(ch);
  }

  onPublish(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function defaultLimits(ch: Channel): BusLimits {
  if (ch.startsWith("terminal:")) return { maxEntries: 50_000, maxBytes: 2 * 1024 * 1024 };
  if (ch.startsWith("session:")) return { maxEntries: 3000, maxBytes: 8 * 1024 * 1024 };
  return { maxEntries: 200, maxBytes: 1024 * 1024 };
}
