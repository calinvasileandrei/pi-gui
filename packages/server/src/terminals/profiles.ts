import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TerminalProfileSchema, TerminalsFileSchema, type ConfigError, type TerminalProfile, type TerminalProfileInfo } from "@pi-gui/protocol";

export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const globalTerminalsFile = () => join(PI_AGENT_DIR, "terminals.json");
export const projectTerminalsFile = (project: string) => join(project, ".pi", "terminals.json");

/** stable `id` so a running terminal is found again after reload */
export type ResolvedProfile = TerminalProfileInfo;

/** Path rules: relative → project root; `~/` → home; absolute as written. */
export function resolveCwd(cwd: string, project: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  if (isAbsolute(cwd)) return cwd;
  return resolve(project, cwd);
}

export function checkDir(p: string): string | undefined {
  if (!existsSync(p)) return `folder does not exist: ${p}`;
  if (!statSync(p).isDirectory()) return `not a folder: ${p}`;
  return undefined;
}

export const profileId = (project: string, name: string) => `p:${project}::${name.toLowerCase()}`;

async function readFileProfiles(file: string, errors: ConfigError[]): Promise<TerminalProfile[]> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return [];
  try {
    const r = TerminalsFileSchema.safeParse(JSON.parse(raw));
    if (r.success) return r.data.terminals;
    errors.push({ file, message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  } catch (e) {
    errors.push({ file, message: `invalid JSON: ${(e as Error).message}` });
  }
  return [];
}

/** Global + project profiles; project wins on a name clash. Invalid files are reported, never thrown. */
export async function loadProfiles(project: string): Promise<{ profiles: ResolvedProfile[]; errors: ConfigError[] }> {
  const errors: ConfigError[] = [];
  const [glob, proj] = await Promise.all([readFileProfiles(globalTerminalsFile(), errors), readFileProfiles(projectTerminalsFile(project), errors)]);
  const byName = new Map<string, ResolvedProfile>();
  const add = (p: TerminalProfile, scope: "project" | "global") => {
    const resolvedCwd = resolveCwd(p.cwd, project);
    byName.set(p.name.toLowerCase(), { ...p, scope, resolvedCwd, cwdError: checkDir(resolvedCwd), id: profileId(project, p.name) });
  };
  for (const p of glob) add(p, "global");
  for (const p of proj) add(p, "project");
  return { profiles: [...byName.values()], errors };
}

async function readRaw(file: string): Promise<TerminalProfile[]> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return [];
  const r = TerminalsFileSchema.safeParse(JSON.parse(raw));
  if (!r.success) throw new Error(`${file} is invalid; fix it before saving: ${r.error.issues[0]?.message}`);
  return r.data.terminals;
}

export async function saveProfile(project: string, scope: "project" | "global", profile: TerminalProfile, previousName?: string) {
  const parsed = TerminalProfileSchema.parse(profile);
  const err = checkDir(resolveCwd(parsed.cwd, project));
  if (err) throw new Error(err);
  const file = scope === "project" ? projectTerminalsFile(project) : globalTerminalsFile();
  const list = await readRaw(file);
  const key = (previousName ?? parsed.name).toLowerCase();
  const rest = list.filter((p) => p.name.toLowerCase() !== key && p.name.toLowerCase() !== parsed.name.toLowerCase());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ terminals: [...rest, parsed] }, null, 2) + "\n");
}

export async function deleteProfile(project: string, scope: "project" | "global", name: string) {
  const file = scope === "project" ? projectTerminalsFile(project) : globalTerminalsFile();
  const list = await readRaw(file);
  await writeFile(file, JSON.stringify({ terminals: list.filter((p) => p.name.toLowerCase() !== name.toLowerCase()) }, null, 2) + "\n");
}
