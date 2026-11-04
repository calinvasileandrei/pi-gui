// Per-project state shared by the explorer, the git panel and the editor tabs:
// git status (polled + pushed), and a tiny event hub for "this folder changed on disk".
import { useEffect } from "react";
import { create } from "zustand";
import type { ChangedFile, ChangesInfo } from "@pi-gui/protocol";
import { conn } from "./ws.ts";

interface ProjectStore {
  git: Record<string, ChangesInfo | undefined>;
  gitError: Record<string, string | undefined>;
}
export const useProject = create<ProjectStore>(() => ({ git: {}, gitError: {} }));

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Refresh git status for a project (coalesced: at most one request in flight + one queued). */
export function refreshGit(cwd: string): Promise<void> {
  if (inflight.has(cwd)) {
    again.add(cwd);
    return inflight.get(cwd)!;
  }
  const p = conn
    .req<ChangesInfo>("git.status", { cwd })
    .then(
      (info) => useProject.setState((s) => ({ git: { ...s.git, [cwd]: info }, gitError: { ...s.gitError, [cwd]: undefined } })),
      (e: Error) => useProject.setState((s) => ({ gitError: { ...s.gitError, [cwd]: e.message } })),
    )
    .finally(() => {
      inflight.delete(cwd);
      if (again.delete(cwd)) void refreshGit(cwd);
    });
  inflight.set(cwd, p);
  return p;
}

let timer: ReturnType<typeof setTimeout> | undefined;
export function refreshGitSoon(cwd: string, ms = 250) {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshGit(cwd), ms);
}

// ---- disk change hub ----
type FsListener = (root: string, dir: string) => void;
const fsListeners = new Set<FsListener>();
export function onFsChanged(l: FsListener): () => void {
  fsListeners.add(l);
  return () => fsListeners.delete(l);
}
let hubStarted = false;
function startHub() {
  if (hubStarted) return;
  hubStarted = true;
  conn.sub("app", (e) => {
    if (e.kind === "fs_changed") for (const l of fsListeners) l(e.root, e.dir);
  });
}

/**
 * Keeps the git status of the focused project fresh: on focus, on disk events, when the agent
 * edits (changesVersion) and every few seconds while the window is visible (commits from a terminal).
 */
export function useProjectSync(project: string | undefined, changesVersion: number) {
  useEffect(() => {
    startHub();
    if (!project) return;
    void refreshGit(project);
    const off = onFsChanged((root) => {
      if (root === project || project.startsWith(root + "/") || root.startsWith(project + "/")) refreshGitSoon(project, 300);
    });
    const t = setInterval(() => document.visibilityState === "visible" && void refreshGit(project), 5000);
    const onVis = () => document.visibilityState === "visible" && void refreshGit(project);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [project]);
  useEffect(() => {
    if (project && changesVersion) refreshGitSoon(project, 200);
  }, [project, changesVersion]);
}

/** git status keyed by path relative to the *project folder* (the explorer's root), plus folders containing changes. */
export function decorations(project: string, info: ChangesInfo | undefined): { files: Map<string, ChangedFile>; dirs: Set<string> } {
  const files = new Map<string, ChangedFile>();
  const dirs = new Set<string>();
  if (!info) return { files, dirs };
  const root = info.root.replace(/\/$/, "");
  const prefix = project === root ? "" : project.startsWith(root + "/") ? project.slice(root.length + 1) + "/" : null;
  if (prefix === null) return { files, dirs };
  for (const f of info.files) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length);
    files.set(rel, f);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return { files, dirs };
}

/** project-relative → git-root-relative (for git ops) */
export function toGitPath(project: string, info: ChangesInfo | undefined, rel: string): string {
  if (!info) return rel;
  const root = info.root.replace(/\/$/, "");
  return project === root || !project.startsWith(root + "/") ? rel : `${project.slice(root.length + 1)}/${rel}`;
}

export const STATUS_LETTER: Record<ChangedFile["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "!" };
