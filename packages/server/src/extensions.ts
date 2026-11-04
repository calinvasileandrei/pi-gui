import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionInfo } from "@pi-gui/protocol";
import { PI_AGENT_DIR } from "./terminals/profiles.ts";

/**
 * Mirrors pi's own resource rules (core/package-manager.js, pi 0.73.1):
 *  - auto-discovered: <base>/extensions/*.ts|js  and  <base>/extensions/<dir>/index.ts|js
 *    (base = ~/.pi/agent for global, <project>/.pi for project)
 *  - disabled auto entry = a "-<path relative to base>" pattern in that scope's settings.json "extensions"
 *  - explicit entries = plain paths in settings.json "extensions"
 * Everything set here is exactly what `pi config` / pi in the terminal sees.
 */
const EXT_FILE = /\.(ts|js|mjs|cjs|mts)$/;

export const scopeBase = (scope: "global" | "project", project?: string) => (scope === "global" ? PI_AGENT_DIR : join(project!, ".pi"));
const settingsFile = (scope: "global" | "project", project?: string) => join(scopeBase(scope, project), "settings.json");

async function readSettings(file: string): Promise<Record<string, any>> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON — fix it before changing extensions`);
  }
}
async function writeSettings(file: string, s: Record<string, any>) {
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2) + "\n");
}

async function autoEntries(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isFile() && EXT_FILE.test(d.name)) out.push(p);
    else if (d.isDirectory()) {
      for (const idx of ["index.ts", "index.js", "index.mjs"]) if (existsSync(join(p, idx))) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

const nameOf = (p: string) => (EXT_FILE.test(p) ? basename(p, extname(p)) : basename(p));

export async function listExtensions(project: string | undefined, bridgePath?: string): Promise<ExtensionInfo[]> {
  const out: ExtensionInfo[] = [];
  if (bridgePath) out.push({ path: bridgePath, name: "gui-bridge", scope: "global", source: "settings", enabled: true, builtin: true });
  const scopes: ("global" | "project")[] = project ? ["project", "global"] : ["global"];
  for (const scope of scopes) {
    const base = scopeBase(scope, project);
    const settings = await readSettings(settingsFile(scope, project)).catch(() => ({}) as Record<string, any>);
    const entries: string[] = Array.isArray(settings.extensions) ? settings.extensions : [];
    const forceExcluded = new Set(entries.filter((e) => e.startsWith("-")).map((e) => resolve(base, e.slice(1))));
    for (const p of await autoEntries(join(base, "extensions"))) {
      out.push({ path: p, name: nameOf(p), scope, source: "auto", enabled: !forceExcluded.has(p) });
    }
    for (const e of entries) {
      if (/^[!+-]/.test(e) || e.includes("*")) continue;
      const p = isAbsolute(e) ? e : resolve(base, e);
      out.push({ path: p, name: nameOf(p), scope, source: "settings", enabled: true });
    }
    // entries the GUI parked (disabled explicit paths) so they can be re-enabled
    for (const p of (settings["piGuiDisabledExtensions"] as string[] | undefined) ?? []) {
      out.push({ path: p, name: nameOf(p), scope, source: "settings", enabled: false });
    }
    for (const pkg of (settings.packages as unknown[] | undefined) ?? []) {
      const src = typeof pkg === "string" ? pkg : (pkg as { source?: string })?.source;
      if (src) out.push({ path: src, name: src, scope, source: "package", enabled: true });
    }
  }
  return out;
}

export async function setExtensionEnabled(ext: { path: string; scope: "global" | "project"; source: ExtensionInfo["source"] }, enabled: boolean, project?: string) {
  if (ext.source === "package") throw new Error("Packages are managed with `pi config` / `pi remove` for now");
  const base = scopeBase(ext.scope, project);
  const file = settingsFile(ext.scope, project);
  const s = await readSettings(file);
  const entries: string[] = Array.isArray(s.extensions) ? [...s.extensions] : [];
  if (ext.source === "auto") {
    const pattern = `-${relative(base, ext.path)}`;
    const next = entries.filter((e) => !(e.startsWith("-") && resolve(base, e.slice(1)) === ext.path));
    if (!enabled) next.push(pattern);
    s.extensions = next;
  } else {
    const parked: string[] = s.piGuiDisabledExtensions ?? [];
    const same = (e: string) => (isAbsolute(e) ? e : resolve(base, e)) === ext.path;
    if (enabled) {
      s.piGuiDisabledExtensions = parked.filter((p) => p !== ext.path);
      if (!entries.some(same)) entries.push(ext.path);
    } else {
      s.piGuiDisabledExtensions = [...new Set([...parked, ext.path])];
      entries.splice(0, entries.length, ...entries.filter((e) => !same(e)));
    }
    if (s.piGuiDisabledExtensions.length === 0) delete s.piGuiDisabledExtensions;
    s.extensions = entries;
  }
  if (s.extensions.length === 0) delete s.extensions;
  await writeSettings(file, s);
}

export async function addExtension(path: string, scope: "global" | "project", project?: string) {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  const file = settingsFile(scope, project);
  const s = await readSettings(file);
  const entries: string[] = Array.isArray(s.extensions) ? s.extensions : [];
  if (!entries.includes(path)) entries.push(path);
  s.extensions = entries;
  await writeSettings(file, s);
}

/** Source review before enabling: file list + main file contents (capped). */
export async function inspectExtension(path: string): Promise<{ files: { path: string; size: number }[]; main?: string; mainContent?: string; packageJson?: string }> {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  const files: { path: string; size: number }[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 4 || files.length > 400) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else files.push({ path: relative(path, p), size: statSync(p).size });
    }
  };
  let main: string | undefined;
  if (statSync(path).isDirectory()) {
    await walk(path, 0);
    main = ["index.ts", "index.js", "index.mjs", "src/index.ts"].map((f) => join(path, f)).find(existsSync);
  } else {
    files.push({ path: basename(path), size: statSync(path).size });
    main = path;
  }
  const cap = (s: string) => (s.length > 200_000 ? s.slice(0, 200_000) + "\n… (truncated)" : s);
  const pkg = statSync(path).isDirectory() && existsSync(join(path, "package.json")) ? await readFile(join(path, "package.json"), "utf8") : undefined;
  return { files, main, mainContent: main ? cap(await readFile(main, "utf8")) : undefined, packageJson: pkg };
}

/** Shallow-clone a git URL into the GUI's review area. Nothing is enabled until the user adds it. */
export function fetchGitExtension(url: string, guiDir: string): Promise<string> {
  if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~-]+$/.test(url)) return Promise.reject(new Error("unsupported git URL"));
  const slug = url.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("-").replace(/[^\w.-]/g, "_");
  const dest = join(guiDir, "extension-src", `${slug}-${Date.now()}`);
  return new Promise((res, rej) =>
    execFile("git", ["clone", "--depth", "1", "--", url, dest], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000 }, (e, _o, err) =>
      e ? rej(new Error(String(err || e.message).trim())) : res(dest),
    ),
  );
}
