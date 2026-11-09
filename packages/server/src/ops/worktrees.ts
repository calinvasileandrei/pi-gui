import { dirname, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import type { Bus } from "../bus.ts";
import type { OpHandler } from "../http.ts";
import type { Supervisor } from "../sessions.ts";
import type { PtyManager } from "../terminals/pty.ts";
import { WorktreePrefs, createWorktree, defaultBranch, listBranches, listWorktrees, removeWorktree, repoOf, slug, suggestPath } from "../worktrees.ts";
import { expandHome } from "./sessions.ts";

const abs = (p: string) => {
  const r = resolve(expandHome(p));
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
};
const under = (p: string, root: string) => p === root || p.startsWith(root + sep);

export function worktreeOps({ sup, ptys, bus, prefsFile }: { sup: Supervisor; ptys: PtyManager; bus: Bus; prefsFile: string }) {
  const prefs = new WorktreePrefs(prefsFile);
  const changed = (repo: string) => bus.publish("app", { kind: "worktrees_changed", repo });

  const ops: Record<string, OpHandler> = {
    /** the repo + all its worktrees for any folder inside it (null: not a git repo) */
    "wt.list": async (a) => listWorktrees(abs(z.object({ dir: z.string() }).parse(a).dir)),

    /** everything the "New worktree" dialog needs */
    "wt.prepare": async (a) => {
      const dir = abs(z.object({ dir: z.string() }).parse(a).dir);
      const repo = await repoOf(dir);
      if (!repo) throw new Error("this folder isn't in a git repository");
      const [list, branches, base, p] = await Promise.all([listWorktrees(repo.main), listBranches(repo.main), defaultBranch(repo.main), prefs.get(repo.main)]);
      const current = list?.worktrees.find((w) => w.path === repo.top)?.branch;
      return { repo: repo.main, defaultBranch: base, current, branches, prefs: p, taken: list?.worktrees.map((w) => w.branch).filter(Boolean) ?? [] };
    },
    "wt.suggestPath": async (a) => {
      const { repo, branch } = z.object({ repo: z.string(), branch: z.string() }).parse(a);
      const list = await listWorktrees(abs(repo));
      if (!list) throw new Error("not a git repository");
      return suggestPath(list.repo, list.worktrees.map((w) => w.path), branch || "new-branch", (await prefs.get(list.repo)).dir);
    },

    "wt.create": async (a) => {
      const p = z
        .object({
          repo: z.string(),
          branch: z.string().min(1),
          base: z.string().optional(),
          existing: z.boolean().default(false),
          path: z.string().min(1),
          copy: z.array(z.string()).default([]),
          setup: z.string().default(""),
        })
        .parse(a);
      const repo = abs(p.repo);
      const r = await createWorktree({ repo, branch: p.branch, base: p.base, existing: p.existing, path: abs(p.path), copy: p.copy });
      await prefs.set(repo, { setup: p.setup.trim() || undefined, copy: p.copy, dir: dirname(r.path) });
      let terminalId: string | undefined;
      if (p.setup.trim()) {
        const t = ptys.open({ name: `setup · ${slug(p.branch)}`, cwd: r.path, command: p.setup.trim(), profile: false, project: r.path });
        terminalId = t.id;
        ptys.publishList();
      }
      changed(repo);
      return { ...r, terminalId };
    },

    "wt.remove": async (a) => {
      const p = z.object({ path: z.string(), force: z.boolean().default(false), deleteBranch: z.boolean().default(false) }).parse(a);
      const path = abs(p.path);
      const repo = (await repoOf(path).catch(() => null))?.main ?? dirname(path);
      // nothing may keep running inside a folder that's about to disappear
      for (const s of sup.list()) if (!s.parentId && under(abs(s.cwd), path)) await sup.remove(s.id);
      for (const t of ptys.list()) if (under(abs(t.cwd), path)) await ptys.remove(t.id);
      const r = await removeWorktree({ path, force: p.force, deleteBranch: p.deleteBranch });
      changed(repo);
      return r;
    },
  };
  return { ops };
}
