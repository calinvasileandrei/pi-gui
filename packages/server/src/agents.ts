import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { AgentFrontmatterSchema, type AgentDefinition, type ConfigError } from "@pi-gui/protocol";
import { PI_AGENT_DIR } from "./terminals/profiles.ts";

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const BRIDGE_TOOLS = ["subagent", "notes_read", "notes_append", "terminal_read", "message_parent", "ask_parent"];
export const WRITE_TOOLS = new Set(["edit", "write", "bash"]);

export const agentsDir = (scope: "project" | "global", project?: string) =>
  scope === "global" ? join(PI_AGENT_DIR, "agents") : join(project!, ".pi", "agents");

async function readDir(dir: string, scope: "project" | "global", errors: ConfigError[]): Promise<AgentDefinition[]> {
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  const seen = new Map<string, string>();
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".md")).sort()) {
    const file = join(dir, f);
    try {
      const { data, content } = matter(await readFile(file, "utf8"));
      const r = AgentFrontmatterSchema.safeParse(data);
      if (!r.success) {
        errors.push({ file, message: r.error.issues.map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`).join("; ") });
        continue;
      }
      const key = r.data.name.toLowerCase();
      if (seen.has(key)) {
        errors.push({ file, message: `duplicate agent name "${r.data.name}" (also in ${seen.get(key)})` });
        continue;
      }
      seen.set(key, f);
      out.push({ ...r.data, systemPrompt: content.trim(), scope, file });
    } catch (e) {
      errors.push({ file, message: (e as Error).message });
    }
  }
  return out;
}

/** Global + project agents; project wins on a name clash. */
export async function loadAgents(project?: string): Promise<{ agents: AgentDefinition[]; errors: ConfigError[] }> {
  const errors: ConfigError[] = [];
  const glob = await readDir(agentsDir("global"), "global", errors);
  const proj = project ? await readDir(agentsDir("project", project), "project", errors) : [];
  const by = new Map<string, AgentDefinition>();
  for (const a of [...glob, ...proj]) by.set(a.name.toLowerCase(), a);
  return { agents: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/** Validation beyond the schema: tools that exist, a model the user actually has. */
export function validateAgent(a: Pick<AgentDefinition, "name" | "tools" | "model">, opts: { models?: string[]; extraTools?: string[] } = {}): string[] {
  const problems: string[] = [];
  const known = new Set([...BUILTIN_TOOLS, ...BRIDGE_TOOLS, ...(opts.extraTools ?? [])]);
  for (const t of a.tools ?? []) if (!known.has(t) && !/^mcp__[A-Za-z0-9_.*-]+$/.test(t)) problems.push(`unknown tool "${t}"`);
  if (a.model && opts.models && opts.models.length) {
    const m = a.model.replace(/:(off|minimal|low|medium|high|xhigh)$/, "");
    const ok = opts.models.some((x) => x === m || x.endsWith(`/${m}`));
    if (!ok) problems.push(`model "${a.model}" is not available (log in to its provider, or pick another)`);
  }
  return problems;
}

export function serializeAgent(a: Omit<AgentDefinition, "scope" | "file">): string {
  const fm: Record<string, unknown> = { name: a.name, description: a.description };
  if (a.model) fm.model = a.model;
  if (a.thinking) fm.thinking = a.thinking;
  if (a.tools) fm.tools = a.tools.join(", ");
  if (a.extensions) fm.extensions = a.extensions;
  if (a.maxTurns) fm.maxTurns = a.maxTurns;
  if (a.timeoutSec) fm.timeoutSec = a.timeoutSec;
  if (a.canSpawn) fm.canSpawn = true;
  return matter.stringify(`${a.systemPrompt.trim()}\n`, fm);
}

export async function saveAgent(a: Omit<AgentDefinition, "file">, project?: string, previousFile?: string) {
  const parsed = AgentFrontmatterSchema.parse(a);
  const dir = agentsDir(a.scope, project);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${parsed.name}.md`);
  const { agents } = await loadAgents(project);
  const clash = agents.find((x) => x.name.toLowerCase() === parsed.name.toLowerCase() && x.file !== previousFile && x.scope === a.scope);
  if (clash) throw new Error(`an agent named "${parsed.name}" already exists (${clash.file})`);
  await writeFile(file, serializeAgent({ ...parsed, systemPrompt: a.systemPrompt }));
  if (previousFile && previousFile !== file) await rm(previousFile, { force: true });
  return file;
}

export async function deleteAgent(file: string, project?: string) {
  const ok = [agentsDir("global"), project ? agentsDir("project", project) : ""].some((d) => d && file.startsWith(d + "/"));
  if (!ok || !file.endsWith(".md")) throw new Error("not an agent definition file");
  await rm(file, { force: true });
}
