// Import subagents from other coding tools into pi's format (.pi/agents/*.md).
// Each tool names its tools differently; we map what has a pi equivalent and say what was dropped.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { BUILTIN_TOOLS } from "./agents.ts";
import { parseJsonc } from "./mcp.ts";

export interface ImportedAgent {
  name: string;
  description: string;
  tools?: string[];
  canSpawn: boolean;
  systemPrompt: string;
  /** what didn't carry over, shown before importing */
  notes: string[];
  /** where it came from */
  file: string;
}
export interface AgentImportSource {
  id: string;
  label: string;
  path: string;
  agents: ImportedAgent[];
}

type Raw = Record<string, any>;

const CLAUDE_TOOLS: Record<string, string[]> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  MultiEdit: ["edit"],
  NotebookEdit: ["edit"],
  Bash: ["bash"],
  BashOutput: ["bash"],
  KillBash: ["bash"],
  KillShell: ["bash"],
  Grep: ["grep"],
  Glob: ["find"],
  LS: ["ls"],
};
const OPENCODE_TOOLS: Record<string, string[]> = { read: ["read"], write: ["write"], edit: ["edit"], patch: ["edit"], bash: ["bash"], grep: ["grep"], glob: ["find"], list: ["ls"] };
const COPILOT_TOOLS: Record<string, string[]> = {
  codebase: ["read", "grep", "find", "ls"],
  search: ["read", "grep", "find", "ls"],
  read: ["read"],
  readFile: ["read"],
  usages: ["grep"],
  findTestFiles: ["find"],
  editFiles: ["edit", "write"],
  edit: ["edit", "write"],
  new: ["write"],
  runCommands: ["bash"],
  runInTerminal: ["bash"],
  terminal: ["bash"],
  runTests: ["bash"],
};

const safeName = (s: string) =>
  s
    .trim()
    .replace(/\.(agent|chatmode)$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^[-_]+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48) || "agent";

const csv = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined;

function mapList(list: string[] | undefined, table: Record<string, string[]>, notes: string[]): { tools?: string[]; canSpawn: boolean } {
  if (!list) return { canSpawn: false }; // no list = every tool, same in pi
  const out = new Set<string>();
  const dropped: string[] = [];
  let canSpawn = false;
  for (const t of list) {
    if (t === "*") return { canSpawn: false };
    if (/^mcp__/.test(t)) out.add(t); // same naming in Claude Code and pi
    else if (t === "Task" || t === "task" || t === "Agent") canSpawn = true;
    else if (table[t]) table[t]!.forEach((x) => out.add(x));
    else dropped.push(t);
  }
  if (canSpawn) out.add("subagent");
  if (dropped.length) notes.push(`no pi equivalent, dropped: ${dropped.join(", ")}`);
  return { tools: [...out], canSpawn };
}

function modelNote(model: unknown, notes: string[]) {
  if (typeof model === "string" && model && model !== "inherit") notes.push(`model "${model}" not carried over — it runs on your default model (pick one after importing)`);
}

function fromClaude(fm: Raw, body: string, file: string): ImportedAgent {
  const notes: string[] = [];
  const { tools, canSpawn } = mapList(csv(fm.tools), CLAUDE_TOOLS, notes);
  modelNote(fm.model, notes);
  return { name: safeName(String(fm.name ?? basename(file, ".md"))), description: String(fm.description ?? ""), tools, canSpawn, systemPrompt: body.trim(), notes, file };
}

/** OpenCode: tools is a map of name → enabled; anything not set to false stays on */
function fromOpenCode(fm: Raw, body: string, file: string, name?: string): ImportedAgent {
  const notes: string[] = [];
  let tools: string[] | undefined;
  let canSpawn = false;
  const t = fm.tools && typeof fm.tools === "object" ? (fm.tools as Record<string, boolean>) : undefined;
  if (t && Object.values(t).some((v) => v === false)) {
    const off = new Set<string>();
    // patch also maps to edit; turning off only patch keeps edit
    for (const [k, v] of Object.entries(t)) if (v === false && k !== "patch") (OPENCODE_TOOLS[k] ?? []).forEach((x) => off.add(x));
    tools = BUILTIN_TOOLS.filter((x) => !off.has(x));
  }
  if (t?.task === true) {
    canSpawn = true;
    if (tools) tools.push("subagent");
  }
  if (fm.mode === "primary") notes.push("a primary agent in OpenCode — imported as a subagent");
  modelNote(fm.model, notes);
  const prompt = typeof fm.prompt === "string" && !body.trim() ? fm.prompt : body;
  if (typeof fm.prompt === "string" && fm.prompt.startsWith("{file:")) notes.push(`prompt is in a separate file (${fm.prompt}) — paste it in after importing`);
  return { name: safeName(name ?? String(fm.name ?? basename(file, ".md"))), description: String(fm.description ?? ""), tools, canSpawn, systemPrompt: prompt.trim(), notes, file };
}

function fromCopilot(fm: Raw, body: string, file: string): ImportedAgent {
  const notes: string[] = [];
  const { tools, canSpawn } = mapList(csv(fm.tools), COPILOT_TOOLS, notes);
  modelNote(fm.model, notes);
  return { name: safeName(String(fm.name ?? basename(file, ".md"))), description: String(fm.description ?? ""), tools, canSpawn, systemPrompt: body.trim(), notes, file };
}

async function mdDir(dir: string, parse: (fm: Raw, body: string, file: string) => ImportedAgent, ext = ".md"): Promise<ImportedAgent[]> {
  if (!existsSync(dir)) return [];
  const out: ImportedAgent[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(ext)).sort()) {
    const file = join(dir, f);
    try {
      const { data, content } = matter(await readFile(file, "utf8"));
      const a = parse(data, content, file);
      if (a.systemPrompt || a.description) out.push(a);
    } catch {
      /* not a valid agent file */
    }
  }
  return out;
}

async function openCodeJson(file: string): Promise<ImportedAgent[]> {
  if (!existsSync(file)) return [];
  try {
    const j = parseJsonc(await readFile(file, "utf8")) as Raw;
    const agents = j?.agent && typeof j.agent === "object" ? (j.agent as Record<string, Raw>) : {};
    return Object.entries(agents)
      .filter(([, v]) => v && typeof v === "object" && v.disable !== true && (v.prompt || v.description))
      .map(([name, v]) => fromOpenCode(v, "", file, name));
  } catch {
    return [];
  }
}

/** Agents other tools on this Mac (and in this project) already define. */
export async function findAgentImportSources(project?: string): Promise<AgentImportSource[]> {
  const h = homedir();
  const oc = join(h, ".config/opencode");
  const cands: { id: string; label: string; path: string; load: () => Promise<ImportedAgent[]> }[] = [
    { id: "claude-code", label: "Claude Code", path: join(h, ".claude/agents"), load: () => mdDir(join(h, ".claude/agents"), fromClaude) },
    { id: "opencode", label: "OpenCode", path: join(oc, "agent"), load: async () => [...(await mdDir(join(oc, "agent"), (f, b, p) => fromOpenCode(f, b, p))), ...(await mdDir(join(oc, "agents"), (f, b, p) => fromOpenCode(f, b, p)))] },
    { id: "opencode-json", label: "OpenCode · opencode.json", path: join(oc, "opencode.json"), load: async () => [...(await openCodeJson(join(oc, "opencode.json"))), ...(await openCodeJson(join(oc, "opencode.jsonc")))] },
  ];
  if (project) {
    cands.push(
      { id: "project-claude", label: "This project · Claude Code", path: join(project, ".claude/agents"), load: () => mdDir(join(project, ".claude/agents"), fromClaude) },
      {
        id: "project-opencode",
        label: "This project · OpenCode",
        path: join(project, ".opencode/agent"),
        load: async () => [
          ...(await mdDir(join(project, ".opencode/agent"), (f, b, p) => fromOpenCode(f, b, p))),
          ...(await mdDir(join(project, ".opencode/agents"), (f, b, p) => fromOpenCode(f, b, p))),
          ...(await openCodeJson(join(project, "opencode.json"))),
          ...(await openCodeJson(join(project, "opencode.jsonc"))),
        ],
      },
      {
        id: "project-copilot",
        label: "This project · GitHub Copilot",
        path: join(project, ".github/agents"),
        load: async () => [...(await mdDir(join(project, ".github/agents"), fromCopilot, ".agent.md")), ...(await mdDir(join(project, ".github/chatmodes"), fromCopilot, ".chatmode.md"))],
      },
    );
  }
  const out: AgentImportSource[] = [];
  for (const c of cands) {
    const agents = await c.load().catch(() => []);
    // one name per source (first wins)
    const seen = new Set<string>();
    const uniq = agents.filter((a) => !seen.has(a.name) && seen.add(a.name));
    if (uniq.length) out.push({ id: c.id, label: c.label, path: c.path, agents: uniq });
  }
  return out;
}
