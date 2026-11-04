import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { FsEntry } from "@pi-gui/protocol";
import { languageFor } from "./changes.ts";

const MAX_OPEN_BYTES = 4 * 1024 * 1024;
/** never shown: VCS internals and macOS litter */
const HIDDEN = new Set([".git", ".DS_Store", ".hg", ".svn"]);

/** Resolve `rel` inside `root`; throws if it escapes. "" or "." is the root itself. */
export function inside(root: string, rel: string): string {
  const r = resolve(root);
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(r, rel || ".");
  const back = relative(r, abs);
  if (back.startsWith("..") || isAbsolute(back)) throw new Error(`path outside the project: ${rel}`);
  return abs;
}
const relOf = (root: string, abs: string) => relative(resolve(root), abs).split(sep).join("/");

function gitIgnored(cwd: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return Promise.resolve(new Set());
  return new Promise((r) => {
    const p = execFile("git", ["check-ignore", "-z", "--stdin"], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (_e, out) =>
      r(new Set(String(out ?? "").split("\0").filter(Boolean))),
    );
    p.stdin?.end(names.join("\0"));
  });
}

/** One directory level, folders first. `ignored` marks gitignored entries (shown dimmed). */
export async function listDir(root: string, rel: string): Promise<FsEntry[]> {
  const abs = inside(root, rel);
  const dirents = await readdir(abs, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const d of dirents) {
    if (HIDDEN.has(d.name)) continue;
    let dir = d.isDirectory();
    if (d.isSymbolicLink()) dir = await stat(join(abs, d.name)).then((s) => s.isDirectory(), () => false);
    out.push({ name: d.name, path: relOf(root, join(abs, d.name)), dir, link: d.isSymbolicLink() || undefined });
  }
  const ignored = existsSync(abs) ? await gitIgnored(abs, out.map((e) => e.name + (e.dir ? "/" : ""))) : new Set<string>();
  for (const e of out) if (ignored.has(e.name) || ignored.has(e.name + "/")) e.ignored = true;
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

async function free(dest: string) {
  if (existsSync(dest)) throw new Error(`${basename(dest)} already exists there`);
}

/** Move entries (relative paths) into a folder of the same project. Returns the new relative paths. */
export async function movePaths(root: string, from: string[], toDir: string): Promise<string[]> {
  const target = inside(root, toDir);
  if (!(await stat(target)).isDirectory()) throw new Error("drop target is not a folder");
  const moved: string[] = [];
  for (const rel of from) {
    const src = inside(root, rel);
    if (src === resolve(root)) throw new Error("can't move the project folder itself");
    if (target === src || target.startsWith(src + sep)) throw new Error(`can't move ${basename(src)} into itself`);
    const dest = join(target, basename(src));
    if (dest === src) continue;
    await free(dest);
    await rename(src, dest);
    moved.push(relOf(root, dest));
  }
  return moved;
}

/** Copy files/folders from anywhere on disk (Finder drop) into a project folder. */
export async function copyIn(root: string, sources: string[], toDir: string): Promise<string[]> {
  const target = inside(root, toDir);
  const out: string[] = [];
  for (const s of sources) {
    if (!isAbsolute(s)) throw new Error("dropped paths must be absolute");
    const dest = join(target, basename(s));
    if (resolve(s) === dest) continue;
    if (target.startsWith(resolve(s) + sep)) throw new Error(`can't copy ${basename(s)} into itself`);
    await free(dest);
    await cp(s, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    out.push(relOf(root, dest));
  }
  return out;
}

/** Browser fallback for dropped files (no filesystem path available): write bytes. */
export async function writeUpload(root: string, toDir: string, name: string, base64: string): Promise<string> {
  if (!name || name.includes("/") || name.includes("\\") || name === ".." || name === ".") throw new Error("bad file name");
  const dest = join(inside(root, toDir), name);
  await free(dest);
  await writeFile(dest, Buffer.from(base64, "base64"));
  return relOf(root, dest);
}

export async function createEntry(root: string, rel: string, dir: boolean): Promise<string> {
  const abs = inside(root, rel);
  await free(abs);
  if (dir) await mkdir(abs, { recursive: true });
  else {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "", { flag: "wx" });
  }
  return relOf(root, abs);
}

export async function renameEntry(root: string, rel: string, newName: string): Promise<string> {
  if (!newName || newName.includes("/") || newName === "." || newName === "..") throw new Error("bad name");
  const src = inside(root, rel);
  const dest = join(dirname(src), newName);
  if (dest === src) return rel;
  await free(dest);
  await rename(src, dest);
  return relOf(root, dest);
}

/** Never rm: entries go to the GUI trash folder. */
export async function trashEntries(root: string, rels: string[], trashDir: string) {
  await mkdir(trashDir, { recursive: true });
  for (const rel of rels) {
    const src = inside(root, rel);
    if (src === resolve(root)) throw new Error("can't delete the project folder");
    await lstat(src);
    const dest = join(trashDir, `${Date.now()}-${basename(src)}`);
    try {
      await rename(src, dest);
    } catch {
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
    }
  }
}

export interface OpenedFile {
  path: string;
  text: string;
  language: string;
  binary: boolean;
  tooLarge: boolean;
  mtimeMs: number;
  size: number;
}

export async function openFile(root: string, rel: string): Promise<OpenedFile> {
  const abs = inside(root, rel);
  const s = await stat(abs);
  if (s.isDirectory()) throw new Error("that's a folder");
  const base = { path: relOf(root, abs), language: languageFor(abs), mtimeMs: s.mtimeMs, size: s.size };
  if (s.size > MAX_OPEN_BYTES) return { ...base, text: "", binary: false, tooLarge: true };
  const buf = await readFile(abs);
  const binary = buf.subarray(0, 8000).includes(0) || /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|mov|jar|dylib|so|a|o)$/i.test(extname(abs));
  return { ...base, text: binary ? "" : buf.toString("utf8"), binary, tooLarge: false };
}

/** Save with a stale-write guard: refuses if the file changed on disk since it was opened. */
export async function saveFile(root: string, rel: string, text: string, expectMtime?: number): Promise<{ mtimeMs: number }> {
  const abs = inside(root, rel);
  if (expectMtime !== undefined && existsSync(abs)) {
    const now = (await stat(abs)).mtimeMs;
    if (Math.abs(now - expectMtime) > 1) throw new Error("the file changed on disk since you opened it — reload first");
  }
  await writeFile(abs, text);
  return { mtimeMs: (await stat(abs)).mtimeMs };
}

/**
 * Watches only the folders the UI has expanded (depth 0 each), so huge trees cost nothing.
 * Calls back with the changed folder (relative) — debounced per folder.
 */
export class FsWatcher {
  private roots = new Map<string, { w: FSWatcher; dirs: Set<string> }>();
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private onChange: (root: string, dir: string) => void, private maxDirs = 300) {}

  setDirs(root: string, dirs: string[]) {
    const r = resolve(root);
    const want = new Set<string>();
    for (const d of dirs.slice(0, this.maxDirs)) {
      try {
        want.add(inside(r, d));
      } catch {
        /* ignore escapes */
      }
    }
    let cur = this.roots.get(r);
    if (!want.size) {
      void cur?.w.close();
      this.roots.delete(r);
      return;
    }
    if (!cur) {
      const w = watch([], { depth: 0, ignoreInitial: true, followSymlinks: false, ignored: (p) => HIDDEN.has(basename(p)) && p !== r });
      // content changes don't alter the tree but do alter git status, so every event counts
      w.on("all", (_ev, p) => this.fire(r, dirname(p)));
      w.on("error", () => {});
      cur = { w, dirs: new Set() };
      this.roots.set(r, cur);
    }
    for (const d of cur.dirs) if (!want.has(d)) cur.w.unwatch(d);
    for (const d of want) if (!cur.dirs.has(d) && existsSync(d)) cur.w.add(d);
    cur.dirs = want;
  }

  private fire(root: string, absDir: string) {
    const key = root + "\0" + absDir;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.onChange(root, relOf(root, absDir));
      }, 120),
    );
  }

  async close() {
    for (const t of this.timers.values()) clearTimeout(t);
    await Promise.all([...this.roots.values()].map((x) => x.w.close()));
    this.roots.clear();
  }
}
