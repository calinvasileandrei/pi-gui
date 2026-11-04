import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StoredSession } from "@pi-gui/protocol";
import { PI_AGENT_DIR } from "./terminals/profiles.ts";

/** pi's session store (docs/session-format.md): ~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl */
export const sessionsRoot = () => join(PI_AGENT_DIR, "sessions");

const cache = new Map<string, { mtimeMs: number; size: number; s: Omit<StoredSession, "openId"> }>();

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join(" ");
  return "";
}

/** Parse one session file into list metadata. Tolerates partial last lines (file being written). */
export async function readSessionMeta(file: string): Promise<Omit<StoredSession, "openId"> | null> {
  const st = await stat(file).catch(() => null);
  if (!st) return null;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.s;
  const raw = await readFile(file, "utf8").catch(() => "");
  const lines = raw.split("\n");
  let header: { id?: string; cwd?: string; timestamp?: string } | undefined;
  let name: string | undefined;
  let firstMessage: string | undefined;
  let messageCount = 0;
  for (const line of lines) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session") header = e;
    else if (e.type === "session_info") name = e.name || undefined;
    else if (e.type === "message") {
      messageCount++;
      if (!firstMessage && e.message?.role === "user") firstMessage = textOf(e.message.content).trim().slice(0, 200);
    }
  }
  if (!header?.cwd) return null;
  const s = {
    file,
    id: header.id ?? basename(file, ".jsonl"),
    cwd: header.cwd,
    name,
    firstMessage,
    created: header.timestamp ?? st.birthtime.toISOString(),
    modified: st.mtime.toISOString(),
    messageCount,
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, s });
  return s;
}

export async function listStoredSessions(filterCwd?: string): Promise<Omit<StoredSession, "openId">[]> {
  const root = sessionsRoot();
  if (!existsSync(root)) return [];
  const dirs = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(root, d.name)).catch(() => [])) if (f.endsWith(".jsonl")) files.push(join(root, d.name, f));
  }
  const metas = (await Promise.all(files.map(readSessionMeta))).filter((m): m is NonNullable<typeof m> => !!m);
  return metas.filter((m) => !filterCwd || m.cwd === filterCwd).sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Only files inside pi's session store may be renamed/deleted through the GUI. */
export function assertSessionFile(file: string) {
  const root = sessionsRoot();
  if (!file.startsWith(root + "/") || !file.endsWith(".jsonl")) throw new Error("not a pi session file");
}

/** Rename a session that isn't open: append a session_info entry at the current leaf (same as pi's /name). */
export async function renameStoredSession(file: string, name: string) {
  assertSessionFile(file);
  const raw = await readFile(file, "utf8");
  let leaf: string | null = null;
  for (const line of raw.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type !== "session" && e.id) leaf = e.id;
    } catch {
      /* skip */
    }
  }
  const entry = { type: "session_info", id: randomBytes(4).toString("hex"), parentId: leaf, timestamp: new Date().toISOString(), name };
  await appendFile(file, (raw.endsWith("\n") || raw === "" ? "" : "\n") + JSON.stringify(entry) + "\n");
  cache.delete(file);
}

/** Delete = move into the GUI trash folder (recoverable), never unlink. */
export async function trashStoredSession(file: string, trashDir: string) {
  assertSessionFile(file);
  await mkdir(trashDir, { recursive: true });
  await rename(file, join(trashDir, `${Date.now()}-${basename(file)}`));
  cache.delete(file);
}
