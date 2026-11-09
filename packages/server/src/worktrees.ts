// Git worktrees as first-class projects: one repo, many checked-out branches side by side.
// Everything goes through the git CLI, so worktrees made in a terminal show up too.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { WorktreeInfo, WorktreeRepo } from "@pi-gui/protocol";
import { git } from "./changes.ts";

const real = (p: string) => realpath(p).catch(() => resolve(p));

export function parseWorktreeList(out: string): Omit<WorktreeInfo, "main" | "dirty" | "ahead" | "behind" | "merged" | "missing">[] {
  const items: ReturnType<typeof parseWorktreeList> = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;
    const w: (typeof items)[number] = { path: "", head: "" };
    for (const l of lines) {
      const [k, ...rest] = l.split(" ");
      const v = rest.join(" ");
      if (k === "worktree") w.path = v;
      else if (k === "HEAD") w.head = v;
      else if (k === "branch") w.branch = v.replace(/^refs\/heads\//, "");
      else if (k === "detached") w.detached = true;
      else if (k === "bare") w.bare = true;
      else if (k === "locked") w.locked = v || true;
      else if (k === "prunable") w.prunable = v || true;
    }
    if (w.path) items.push(w);
  }
  return items;
}

/** The repo a folder belongs to (its main worktree), or null when it isn't in a git repo. */
export async function repoOf(dir: string): Promise<{ main: string; top: string } | null> {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
  if (!r.ok) return null;
  const [common, top] = r.out.trim().split("\n");
  if (!common || !top) return null;
  // the main worktree is the parent of the common .git dir (non-bare repos)
  const main = basename(common) === ".git" ? dirname(common) : top;
  return { main: await real(main), top: await real(top) };
}

/** The branch new worktrees should start from: origin's default, else main/master, else the main worktree's branch. */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  const o = await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (o.ok && o.out.trim()) return o.out.trim().replace(/^origin\//, "");
  for (const b of ["main", "master", "develop"]) if ((await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).ok) return b;
  const cur = await git(repo, ["branch", "--show-current"]);
  return cur.out.trim() || undefined;
}

async function statusOf(path: string, branch: string | undefined, base: string | undefined) {
  if (!existsSync(path)) return { missing: true };
  const [st, ab, merged] = await Promise.all([
    git(path, ["status", "--porcelain", "-uall"]),
    git(path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    branch && base && branch !== base ? git(path, ["merge-base", "--is-ancestor", "HEAD", base]) : Promise.resolve(undefined),
  ]);
  const dirty = st.ok ? st.out.split("\n").filter(Boolean).length : 0;
  let ahead: number | undefined, behind: number | undefined, upstream = false;
  if (ab.ok) {
    const [b, a] = ab.out.trim().split(/\s+/).map(Number);
    behind = b;
    ahead = a;
    upstream = true;
  }
  // commits that aren't on base yet (for branches never pushed)
  let unique: number | undefined;
  if (branch && base && branch !== base) {
    const u = await git(path, ["rev-list", "--count", `${base}..HEAD`]);
    if (u.ok) unique = Number(u.out.trim());
  }
  return { dirty, ahead, behind, upstream, merged: merged ? merged.ok : undefined, unique };
}

export async function listWorktrees(dir: string): Promise<WorktreeRepo | null> {
  const repo = await repoOf(dir);
  if (!repo) return null;
  const r = await git(repo.main, ["worktree", "list", "--porcelain"]);
  if (!r.ok) throw new Error(r.err.trim() || "git worktree list failed");
  const base = await defaultBranch(repo.main);
  const raw = parseWorktreeList(r.out).filter((w) => !w.bare);
  const items = await Promise.all(
    raw.map(async (w, i) => {
      const path = await real(w.path);
      return { ...w, path, main: i === 0 || path === repo.main, ...(await statusOf(path, w.branch, base)) } as WorktreeInfo;
    }),
  );
  return { repo: repo.main, name: basename(repo.main), current: repo.top, defaultBranch: base, worktrees: items };
}

export const slug = (branch: string) => branch.replace(/^refs\/heads\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";

/** Where a new worktree goes: next to the existing ones if they share a folder, else <repo>.worktrees/<branch> beside the repo. */
export function suggestPath(repo: string, existing: string[], branch: string, saved?: string): string {
  if (saved) return join(saved, slug(branch));
  const linked = existing.filter((p) => p !== repo);
  if (linked.length) {
    const parents = new Set(linked.map((p) => dirname(p)));
    if (parents.size === 1) {
      const parent = [...parents][0]!;
      if (parent !== dirname(repo)) return join(parent, slug(branch));
      return join(parent, `${basename(repo)}-${slug(branch)}`); // siblings like repo-feature-x
    }
  }
  return join(dirname(repo), `${basename(repo)}.worktrees`, slug(branch));
}

export async function listBranches(repo: string): Promise<{ local: string[]; remote: string[] }> {
  const r = await git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of r.out.split("\n").filter(Boolean)) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice(11));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push(ref.slice(13));
  }
  return { local, remote };
}

export interface CreateOpts {
  repo: string;
  branch: string;
  /** start point for a new branch (branch, remote branch or commit) */
  base?: string;
  /** check out an existing branch instead of creating one */
  existing?: boolean;
  path: string;
  /** gitignored files at the repo root to copy (globs: * only), e.g. .env* */
  copy?: string[];
}

export async function createWorktree(o: CreateOpts): Promise<{ path: string; copied: string[] }> {
  const repo = (await repoOf(o.repo))?.main;
  if (!repo) throw new Error("not a git repository");
  const branch = o.branch.trim();
  if (!branch) throw new Error("branch name is required");
  const valid = await git(repo, ["check-ref-format", "--branch", branch]);
  if (!valid.ok) throw new Error(`"${branch}" is not a valid branch name`);
  const path = resolve(o.path);
  if (existsSync(path) && (await readdir(path)).length) throw new Error(`${path} already exists and isn't empty`);
  await mkdir(dirname(path), { recursive: true });

  let args: string[];
  if (o.existing) {
    const local = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    // a remote-only branch: create a local tracking branch
    args = local ? ["worktree", "add", path, branch] : ["worktree", "add", "--track", "-b", branch.replace(/^[^/]+\//, ""), path, branch];
  } else {
    if ((await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok) throw new Error(`branch "${branch}" already exists — pick "existing branch" to check it out`);
    args = ["worktree", "add", "-b", branch, path, ...(o.base ? [o.base] : [])];
    // branching off a remote branch would set it as upstream; we want a fresh, unpushed branch
    if (o.base && /^[^/]+\//.test(o.base) && !(await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${o.base}`])).ok) args.splice(2, 0, "--no-track");
  }
  const r = await git(repo, args);
  if (!r.ok) throw new Error(r.err.trim().replace(/^fatal: /, "") || "git worktree add failed");
  const copied = await copyIgnored(repo, path, o.copy ?? []);
  return { path: await real(path), copied };
}

/** copy untracked/ignored files (like .env) from the main worktree root — they don't come with a checkout */
async function copyIgnored(from: string, to: string, patterns: string[]): Promise<string[]> {
  if (!patterns.length) return [];
  const res = patterns.map((p) => new RegExp(`^${p.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
  const names = (await readdir(from, { withFileTypes: true })).filter((d) => d.isFile() && res.some((re) => re.test(d.name))).map((d) => d.name);
  const out: string[] = [];
  for (const n of names) {
    if (existsSync(join(to, n))) continue; // tracked (came with the checkout) or already there
    await copyFile(join(from, n), join(to, n));
    out.push(n);
  }
  return out;
}

export interface RemoveOpts {
  path: string;
  force?: boolean;
  deleteBranch?: boolean;
}

export async function removeWorktree(o: RemoveOpts): Promise<{ branchDeleted?: string }> {
  const info = await listWorktrees(o.path).catch(() => null);
  const target = resolve(o.path);
  if (!info) {
    throw new Error("not a git worktree");
  }
  const w = info.worktrees.find((x) => x.path === target || target.startsWith(x.path + sep));
  if (!w || w.path !== target) throw new Error("not a worktree root");
  if (w.main) throw new Error("that's the main checkout of the repo — it can't be removed here");
  if (w.missing) {
    await git(info.repo, ["worktree", "prune"]);
  } else {
    if (!o.force && (w.dirty ?? 0) > 0) throw new Error(`${w.dirty} uncommitted change${w.dirty === 1 ? "" : "s"} — commit them or remove anyway`);
    const r = await git(info.repo, ["worktree", "remove", ...(o.force ? ["--force", "--force"] : []), w.path]);
    if (!r.ok) throw new Error(r.err.trim().replace(/^fatal: /, ""));
  }
  if (o.deleteBranch && w.branch && w.branch !== info.defaultBranch) {
    const d = await git(info.repo, ["branch", o.force ? "-D" : "-d", w.branch]);
    if (!d.ok) throw new Error(`worktree removed, but the branch was kept: ${d.err.trim().replace(/^error: /, "")}`);
    return { branchDeleted: w.branch };
  }
  return {};
}

// ---- per-repo preferences (setup command, files to copy, folder) ----
export interface RepoPrefs {
  setup?: string;
  copy?: string[];
  dir?: string;
}
export class WorktreePrefs {
  constructor(private file: string) {}
  private async all(): Promise<Record<string, RepoPrefs>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  async get(repo: string): Promise<RepoPrefs> {
    return (await this.all())[repo] ?? {};
  }
  async set(repo: string, p: RepoPrefs) {
    const all = await this.all();
    all[repo] = { ...all[repo], ...p };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2) + "\n");
  }
}
