import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest, ChangedFile, ChangesInfo, FileDiff } from "@pi-gui/protocol";

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((r) =>
    execFile("git", args, { cwd, maxBuffer, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }, (e, out, err) =>
      r({ ok: !e, out: String(out ?? ""), err: String(err ?? "") }),
    ),
  );
}

export async function gitRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out.trim() : null;
}

/** Parse `git status --porcelain=v1 -z` */
export function parsePorcelain(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const x = e[0]!, y = e[1]!;
    const path = e.slice(3);
    let status: ChangedFile["status"] = "modified";
    let oldPath: string | undefined;
    if (x === "?" && y === "?") status = "untracked";
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) status = "conflicted";
    else if (x === "R" || x === "C") {
      status = "renamed";
      oldPath = parts[++i];
    } else if (x === "A") status = "added";
    else if (x === "D" || y === "D") status = "deleted";
    const staged = x !== " " && x !== "?";
    const unstaged = y !== " ";
    files.push({ path, oldPath, status, agent: false, staged, unstaged });
  }
  return files;
}

export function languageFor(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".json": "json", ".md": "markdown", ".css": "css", ".scss": "scss", ".less": "less", ".html": "html",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift",
    ".m": "objective-c", ".mm": "objective-c", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".sh": "shell", ".zsh": "shell", ".bash": "shell", ".yml": "yaml", ".yaml": "yaml", ".xml": "xml", ".sql": "sql",
    ".graphql": "graphql", ".gradle": "groovy", ".php": "php", ".toml": "ini", ".ini": "ini", ".dockerfile": "dockerfile",
  };
  if (basename(path).toLowerCase() === "dockerfile") return "dockerfile";
  return map[ext] ?? "plaintext";
}

const isBinary = (s: string) => s.includes("\0");

async function readText(p: string): Promise<{ text: string; binary: boolean; tooLarge: boolean; exists: boolean }> {
  if (!existsSync(p)) return { text: "", binary: false, tooLarge: false, exists: false };
  if (statSync(p).size > MAX_DIFF_BYTES) return { text: "", binary: false, tooLarge: true, exists: true };
  const text = await readFile(p, "utf8");
  return isBinary(text) ? { text: "", binary: true, tooLarge: false, exists: true } : { text, binary: false, tooLarge: false, exists: true };
}

/**
 * Per-session record of what the agent touched. A snapshot is taken by the gui-bridge extension's
 * blocking tool_call hook *before* the first edit/write of a path, so it's exact (no race with the tool).
 */
export class ChangeTracker {
  /** sessionId -> absPath -> content before the agent's first touch (null = file didn't exist) */
  private snaps = new Map<string, Map<string, string | null>>();
  /** approvals: sessions in "approve every edit" mode, and pending decisions */
  readonly approvalMode = new Set<string>();
  private pending = new Map<string, { req: ApprovalRequest; resolve: (d: { approve: boolean; reason?: string }) => void }>();

  constructor(private onDirty: (sessionId: string, path?: string) => void, private onApproval: (r: ApprovalRequest) => void, private onApprovalDone: (id: string) => void) {}

  async snapshot(sessionId: string, absPath: string) {
    let m = this.snaps.get(sessionId);
    if (!m) this.snaps.set(sessionId, (m = new Map()));
    if (m.has(absPath)) return;
    const r = await readText(absPath);
    m.set(absPath, r.exists && !r.binary && !r.tooLarge ? r.text : r.exists ? "" : null);
  }

  /** snapshots of one session, or merged over several (earliest-registered session wins per path) */
  touched(sessionId: string | string[]): Map<string, string | null> {
    if (typeof sessionId === "string") return this.snaps.get(sessionId) ?? new Map();
    const out = new Map<string, string | null>();
    for (const id of sessionId) for (const [k, v] of this.snaps.get(id) ?? []) if (!out.has(k)) out.set(k, v);
    return out;
  }

  /** Called by the bridge before an edit/write runs. Resolves when the tool may proceed (or is blocked). */
  async beforeWrite(sessionId: string, cwd: string, tool: "edit" | "write", rawPath: string, input: Record<string, unknown>): Promise<{ block: boolean; reason?: string }> {
    const p = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    await this.snapshot(sessionId, abs);
    this.onDirty(sessionId, abs);
    if (!this.approvalMode.has(sessionId)) return { block: false };

    const cur = await readText(abs);
    const proposed = tool === "write" ? String(input.content ?? "") : applyEdits(cur.text, input.edits);
    const req: ApprovalRequest = { id: randomUUID(), sessionId, tool, path: abs, original: cur.text, proposed: proposed ?? cur.text, language: languageFor(abs) };
    return new Promise((resolveDecision) => {
      this.pending.set(req.id, {
        req,
        resolve: (d) => {
          this.pending.delete(req.id);
          this.onApprovalDone(req.id);
          resolveDecision(d.approve ? { block: false } : { block: true, reason: d.reason ? `User rejected this change: ${d.reason}` : "User rejected this change in the GUI." });
        },
      });
      this.onApproval(req);
    });
  }

  decide(id: string, approve: boolean, reason?: string) {
    const p = this.pending.get(id);
    if (!p) throw new Error("approval no longer pending");
    p.resolve({ approve, reason });
  }

  pendingFor(sessionId?: string): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req).filter((r) => !sessionId || r.sessionId === sessionId);
  }

  /** session gone: reject its waiting approvals so the tool calls don't hang */
  dropSession(sessionId: string) {
    for (const p of [...this.pending.values()]) if (p.req.sessionId === sessionId) p.resolve({ approve: false, reason: "session closed" });
    this.snaps.delete(sessionId);
    this.approvalMode.delete(sessionId);
  }

  // ---- queries ----
  async list(sessionId: string | string[], cwd: string): Promise<ChangesInfo> {
    const root = (await gitRoot(cwd)) ?? cwd;
    const isGit = root !== cwd || (await gitRoot(cwd)) !== null;
    const files = new Map<string, ChangedFile>();
    let branch: string | undefined;
    let upstream: { ahead: number; behind: number } | undefined;
    if (isGit) {
      const [st, num, br, ab] = await Promise.all([
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(root, ["diff", "--numstat", "-z", "HEAD"]),
        git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
      ]);
      branch = br.ok ? br.out.trim() : undefined;
      if (ab.ok) {
        const [behind, ahead] = ab.out.trim().split(/\s+/).map(Number);
        upstream = { ahead: ahead ?? 0, behind: behind ?? 0 };
      }
      for (const f of parsePorcelain(st.out)) files.set(f.path, f);
      // numstat -z: "add\tdel\tpath\0" (renames: "add\tdel\t\0old\0new\0")
      const parts = num.out.split("\0");
      for (let i = 0; i < parts.length; i++) {
        const m = parts[i]!.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
        if (!m) continue;
        let path = m[3]!;
        if (!path) {
          i += 2;
          path = parts[i] ?? "";
        }
        const f = files.get(path);
        if (f) {
          f.additions = m[1] === "-" ? undefined : Number(m[1]);
          f.deletions = m[2] === "-" ? undefined : Number(m[2]);
        }
      }
    }
    for (const [abs, before] of this.touched(sessionId)) {
      const rel = relative(root, abs);
      const f = files.get(rel);
      if (f) f.agent = true;
      else if (!isGit) {
        const now = existsSync(abs);
        if (before === null && !now) continue;
        files.set(rel, { path: rel, status: before === null ? "added" : now ? "modified" : "deleted", agent: true });
      }
    }
    return { root, git: isGit, branch, ...upstream, files: [...files.values()].sort((a, b) => Number(b.agent) - Number(a.agent) || a.path.localeCompare(b.path)) };
  }

  async diff(sessionId: string | string[], cwd: string, rel: string, base: "head" | "agent"): Promise<FileDiff> {
    const root = (await gitRoot(cwd)) ?? cwd;
    const abs = resolve(root, rel);
    if (!abs.startsWith(root)) throw new Error("path outside project");
    const cur = await readText(abs);
    let original = "";
    let usedBase = base;
    const snap = this.touched(sessionId).get(abs);
    if (base === "agent" && snap !== undefined) original = snap ?? "";
    else {
      usedBase = "head";
      const r = await git(root, ["show", `HEAD:${rel}`], MAX_DIFF_BYTES * 2);
      original = r.ok ? r.out : snap ?? "";
      if (!r.ok && snap !== undefined) usedBase = "agent";
    }
    return {
      path: rel,
      original: isBinary(original) ? "" : original,
      modified: cur.text,
      language: languageFor(rel),
      binary: cur.binary || isBinary(original),
      tooLarge: cur.tooLarge,
      base: usedBase,
    };
  }

  /** Revert one file to HEAD (git) or to the agent's pre-edit snapshot. Untracked/new files go to the GUI trash, not rm. */
  async revert(sessionId: string | string[], cwd: string, rel: string, base: "head" | "agent", trashDir: string): Promise<void> {
    const root = (await gitRoot(cwd)) ?? cwd;
    const abs = resolve(root, rel);
    if (!abs.startsWith(root)) throw new Error("path outside project");
    const snap = this.touched(sessionId).get(abs);
    if (base === "agent") {
      if (snap === undefined) throw new Error("no pre-edit snapshot for this file");
      if (snap === null) await moveToTrash(abs, trashDir);
      else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, snap);
      }
    } else {
      const tracked = (await git(root, ["ls-files", "--error-unmatch", "--", rel])).ok;
      const inHead = (await git(root, ["cat-file", "-e", `HEAD:${rel}`])).ok;
      if (inHead) {
        const r = await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", rel]);
        if (!r.ok) throw new Error(r.err.trim() || "git restore failed");
      } else {
        if (tracked) await git(root, ["rm", "--cached", "--quiet", "--", rel]);
        await moveToTrash(abs, trashDir);
      }
    }
    for (const id of typeof sessionId === "string" ? [sessionId] : sessionId) this.onDirty(id, abs);
  }
}

// ---- staging / commit (project-level, no session needed) ----
export async function gitStage(cwd: string, paths: string[], stage: boolean) {
  const root = await gitRoot(cwd);
  if (!root) throw new Error("not a git repository");
  for (const p of paths) {
    const back = relative(root, resolve(root, p));
    if (isAbsolute(p) || back.startsWith("..")) throw new Error("path outside repository");
  }
  const args = stage ? ["add", "-A", "--", ...(paths.length ? paths : ["."])] : ["restore", "--staged", "--", ...(paths.length ? paths : ["."])];
  let r = await git(root, args);
  // repos without a commit yet: there is no HEAD to restore from
  if (!r.ok && !stage) r = await git(root, ["rm", "-r", "--cached", "--quiet", "--", ...(paths.length ? paths : ["."])]);
  if (!r.ok) throw new Error(r.err.trim() || "git failed");
}

export async function gitCommit(cwd: string, message: string, all: boolean): Promise<{ hash: string }> {
  const root = await gitRoot(cwd);
  if (!root) throw new Error("not a git repository");
  if (!message.trim()) throw new Error("commit message is empty");
  if (all) {
    const a = await git(root, ["add", "-A"]);
    if (!a.ok) throw new Error(a.err.trim());
  }
  const r = await git(root, ["commit", "-m", message]);
  if (!r.ok) throw new Error((r.err || r.out).trim() || "git commit failed");
  const h = await git(root, ["rev-parse", "--short", "HEAD"]);
  return { hash: h.out.trim() };
}

export async function gitLog(cwd: string, n = 15): Promise<{ hash: string; subject: string; author: string; date: string }[]> {
  const root = await gitRoot(cwd);
  if (!root) return [];
  const r = await git(root, ["log", `-n${n}`, "--pretty=format:%h%x1f%s%x1f%an%x1f%cI%x1e"]);
  if (!r.ok) return [];
  return r.out
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, date] = l.split("\x1f");
      return { hash: hash!, subject: subject ?? "", author: author ?? "", date: date ?? "" };
    });
}

async function moveToTrash(abs: string, trashDir: string) {
  if (!existsSync(abs)) return;
  const dest = join(trashDir, `${Date.now()}-${basename(abs)}`);
  await mkdir(trashDir, { recursive: true });
  try {
    await rename(abs, dest);
  } catch {
    await writeFile(dest, await readFile(abs));
    await rm(abs, { force: true });
  }
}

/** Mirror of pi's edit semantics for the approval preview: each oldText must match once, applied in order. */
export function applyEdits(text: string, edits: unknown): string | undefined {
  if (!Array.isArray(edits)) return undefined;
  let out = text;
  for (const e of edits as { oldText?: string; newText?: string }[]) {
    if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") return undefined;
    const i = out.indexOf(e.oldText);
    if (i < 0) return undefined;
    out = out.slice(0, i) + e.newText + out.slice(i + e.oldText.length);
  }
  return out;
}
