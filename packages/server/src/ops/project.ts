import { join, relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { Bus } from "../bus.ts";
import type { OpHandler } from "../http.ts";
import type { Supervisor } from "../sessions.ts";
import { gitCommit, gitLog, gitRoot, gitStage, type ChangeTracker } from "../changes.ts";
import { FsWatcher, copyIn, createEntry, listDir, movePaths, openFile, renameEntry, saveFile, trashEntries, writeUpload } from "../files.ts";
import { expandHome } from "./sessions.ts";

/**
 * Project-scoped ops (no session needed): the file explorer and the git panel.
 * Everything is confined to `root` — the project folder the UI has open.
 */
export function projectOps(d: { sup: Supervisor; bus: Bus; changes: ChangeTracker; guiDir: string }): { ops: Record<string, OpHandler>; close(): Promise<void> } {
  const { sup, bus, changes } = d;
  const trash = join(d.guiDir, "trash");
  const watcher = new FsWatcher((root, dir) => bus.publish("app", { kind: "fs_changed", root, dir }));
  const Root = z.string().min(1).transform((p) => resolve(expandHome(p)));
  const within = (root: string, cwd: string) => {
    const r = relative(root, cwd);
    return !r.startsWith("..") && !isAbsolute(r);
  };
  /** every GUI session working in this project (its agent snapshots feed the git panel) */
  const sessionsIn = async (cwd: string) => {
    const root = (await gitRoot(cwd)) ?? cwd;
    return sup.list().filter((s) => within(root, resolve(s.cwd)) || within(resolve(s.cwd), root)).map((s) => s.id);
  };

  const ops: Record<string, OpHandler> = {
    "fs.list": async (a) => {
      const { root, dir } = z.object({ root: Root, dir: z.string().default("") }).parse(a);
      return listDir(root, dir);
    },
    "fs.watch": (a) => {
      const { root, dirs } = z.object({ root: Root, dirs: z.array(z.string()) }).parse(a);
      watcher.setDirs(root, dirs);
      return { ok: true };
    },
    "fs.move": async (a) => {
      const { root, from, to } = z.object({ root: Root, from: z.array(z.string()).min(1), to: z.string() }).parse(a);
      return movePaths(root, from, to);
    },
    "fs.copyIn": async (a) => {
      const { root, sources, to } = z.object({ root: Root, sources: z.array(z.string()).min(1), to: z.string() }).parse(a);
      return copyIn(root, sources, to);
    },
    "fs.upload": async (a) => {
      const { root, to, name, data } = z.object({ root: Root, to: z.string(), name: z.string(), data: z.string().max(40 * 1024 * 1024) }).parse(a);
      return writeUpload(root, to, name, data);
    },
    "fs.create": async (a) => {
      const { root, path, dir } = z.object({ root: Root, path: z.string().min(1), dir: z.boolean().default(false) }).parse(a);
      return createEntry(root, path, dir);
    },
    "fs.rename": async (a) => {
      const { root, path, name } = z.object({ root: Root, path: z.string().min(1), name: z.string().min(1) }).parse(a);
      return renameEntry(root, path, name);
    },
    "fs.trash": async (a) => {
      const { root, paths } = z.object({ root: Root, paths: z.array(z.string()).min(1) }).parse(a);
      await trashEntries(root, paths, trash);
      return { ok: true };
    },
    "fs.read": async (a) => {
      const { root, path } = z.object({ root: Root, path: z.string().min(1) }).parse(a);
      return openFile(root, path);
    },
    "fs.write": async (a) => {
      const { root, path, text, mtimeMs } = z.object({ root: Root, path: z.string().min(1), text: z.string(), mtimeMs: z.number().optional() }).parse(a);
      return saveFile(root, path, text, mtimeMs);
    },

    // ---- git panel (project-wide; agent markers merged over all sessions in the project) ----
    "git.status": async (a) => {
      const { cwd } = z.object({ cwd: Root }).parse(a);
      return changes.list(await sessionsIn(cwd), cwd);
    },
    "git.diff": async (a) => {
      const { cwd, path, base } = z.object({ cwd: Root, path: z.string(), base: z.enum(["head", "agent"]).default("head") }).parse(a);
      return changes.diff(await sessionsIn(cwd), cwd, path, base);
    },
    "git.revert": async (a) => {
      const { cwd, path, base } = z.object({ cwd: Root, path: z.string(), base: z.enum(["head", "agent"]).default("head") }).parse(a);
      await changes.revert(await sessionsIn(cwd), cwd, path, base, trash);
      return { ok: true };
    },
    "git.stage": async (a) => {
      const { cwd, paths, stage } = z.object({ cwd: Root, paths: z.array(z.string()), stage: z.boolean() }).parse(a);
      await gitStage(cwd, paths, stage);
      return { ok: true };
    },
    "git.commit": async (a) => {
      const { cwd, message, all } = z.object({ cwd: Root, message: z.string(), all: z.boolean().default(false) }).parse(a);
      return gitCommit(cwd, message, all);
    },
    "git.log": async (a) => {
      const { cwd } = z.object({ cwd: Root }).parse(a);
      return gitLog(cwd);
    },
  };
  return { ops, close: () => watcher.close() };
}
