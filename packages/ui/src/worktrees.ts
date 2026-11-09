// Which repo/worktree each project folder belongs to. Cached per folder, refreshed on
// `worktrees_changed`, window focus, and whenever a new folder shows up in the sidebar.
import { useEffect } from "react";
import { create } from "zustand";
import type { WorktreeInfo, WorktreeRepo } from "@pi-gui/protocol";
import { conn } from "./ws.ts";
import { req } from "./store.ts";

interface WtState {
  /** folder → its repo (null = not in a git repo) */
  byDir: Record<string, WorktreeRepo | null>;
}
export const useWorktrees = create<WtState>(() => ({ byDir: {} }));

const inflight = new Map<string, Promise<WorktreeRepo | null>>();
export function refreshWorktrees(dir: string): Promise<WorktreeRepo | null> {
  let p = inflight.get(dir);
  if (!p) {
    p = req<WorktreeRepo | null>("wt.list", { dir })
      .catch(() => null)
      .then((r) => {
        useWorktrees.setState((s) => {
          const byDir = { ...s.byDir, [dir]: r };
          // every worktree of the repo now has a known answer too
          if (r) {
            for (const w of r.worktrees) byDir[w.path] = { ...r, current: w.path };
            // folders of worktrees that no longer exist
            for (const [d, v] of Object.entries(byDir)) if (v?.repo === r.repo && !r.worktrees.some((w) => under(d, w.path))) delete byDir[d];
          }
          return { byDir };
        });
        return r;
      })
      .finally(() => inflight.delete(dir));
    inflight.set(dir, p);
  }
  return p;
}

const under = (p: string, root: string) => p === root || p.startsWith(root + "/");

/** the worktree a folder is in (and its repo), from the cache */
export function worktreeOf(dir: string | undefined, byDir: WtState["byDir"]): { repo: WorktreeRepo; wt: WorktreeInfo } | undefined {
  if (!dir) return;
  const r = byDir[dir];
  if (!r) return;
  const wt = [...r.worktrees].sort((a, b) => b.path.length - a.path.length).find((w) => under(dir, w.path));
  return wt ? { repo: r, wt } : undefined;
}

/** Keep the given folders' repo info loaded and fresh. */
export function useWorktreeSync(dirs: string[]) {
  const key = [...new Set(dirs)].sort().join("\n");
  useEffect(() => {
    const list = key ? key.split("\n") : [];
    const known = useWorktrees.getState().byDir;
    for (const d of list) if (!(d in known)) void refreshWorktrees(d);
    const all = () => [...new Set([...list, ...Object.keys(useWorktrees.getState().byDir)])];
    const off = conn.sub("app", (e) => {
      if (e.kind !== "worktrees_changed") return;
      for (const d of all()) {
        const r = useWorktrees.getState().byDir[d];
        if (!r || r.repo === e.repo || d === e.repo) void refreshWorktrees(d);
      }
    });
    const onFocus = () => {
      // worktrees made or removed in a terminal
      const repos = new Set<string>();
      for (const d of list) {
        const r = useWorktrees.getState().byDir[d];
        if (r && !repos.has(r.repo)) (repos.add(r.repo), void refreshWorktrees(r.repo));
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [key]);
}
