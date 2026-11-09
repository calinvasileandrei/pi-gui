import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const put = (file: string, text: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));

let home: string;
let proj: string;
const realHome = process.env.HOME;
let mcp: typeof import("./mcp.ts");
let ai: typeof import("./agent-import.ts");

beforeAll(async () => {
  home = tmp("imp-home-");
  proj = tmp("imp-proj-");
  process.env.HOME = home; // os.homedir() follows HOME: the real configs stay out of it
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi/agent");
  delete process.env.CODEX_HOME;
  mcp = await import("./mcp.ts");
  ai = await import("./agent-import.ts");
});
afterAll(() => {
  process.env.HOME = realHome;
});

describe("MCP import from other tools", () => {
  it("reads Codex TOML, OpenCode, Gemini, Zed (JSONC) and Claude Code per-project servers", async () => {
    put(
      join(home, ".codex/config.toml"),
      `model = "x"\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\nenv = { TOKEN = "t" }\ntool_timeout_sec = 30\n\n[mcp_servers.remote]\nurl = "https://r.test/mcp"\nbearer_token_env_var = "R_TOKEN"\n`,
    );
    put(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({ mcp: { gh: { type: "local", command: ["gh-mcp", "--stdio"], environment: { A: "1" }, enabled: false }, web: { type: "remote", url: "https://w.test/mcp" } } }),
    );
    put(join(home, ".gemini/settings.json"), JSON.stringify({ mcpServers: { gem: { httpUrl: "https://g.test/mcp" } } }));
    put(join(home, ".config/zed/settings.json"), `{\n  // comments are fine\n  "context_servers": { "z": { "command": { "path": "zed-mcp", "args": ["a"] } }, "ext": { "source": "extension" } },\n  "theme": "x", // trailing\n}\n`);
    put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cc: { command: "cc" } }, projects: { [proj]: { mcpServers: { local: { type: "stdio", command: "loc" } } } } }));

    const src = Object.fromEntries((await mcp.findImportSources(proj)).map((s) => [s.id, s.servers]));
    expect(src.codex).toEqual({
      docs: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" }, timeout: 30000 },
      remote: { url: "https://r.test/mcp", headers: { Authorization: "Bearer ${R_TOKEN}" } },
    });
    expect(src.opencode).toEqual({ gh: { command: "gh-mcp", args: ["--stdio"], env: { A: "1" }, disabled: true }, web: { url: "https://w.test/mcp" } });
    expect(src.gemini).toEqual({ gem: { url: "https://g.test/mcp", type: "http" } });
    expect(src.zed).toEqual({ z: { command: "zed-mcp", args: ["a"] } });
    expect(src["claude-code"]).toEqual({ cc: { command: "cc" } });
    expect(src["claude-code-local"]).toEqual({ local: { type: "stdio", command: "loc" } });
  });

  it("JSONC keeps // inside strings", () => {
    expect(mcp.parseJsonc(`{"u": "https://x.test/a", /* c */ "b": [1,],}`)).toEqual({ u: "https://x.test/a", b: [1] });
  });
});

describe("agent import from other tools", () => {
  it("maps Claude Code tools and drops what pi doesn't have", async () => {
    put(
      join(home, ".claude/agents/code-reviewer.md"),
      `---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep, Glob, Bash, WebFetch, mcp__github__get_pr\nmodel: sonnet\n---\nYou review code.\n`,
    );
    put(join(home, ".claude/agents/all.md"), `---\nname: All Tools\ndescription: x\n---\nEverything.\n`);
    const cc = (await ai.findAgentImportSources()).find((s) => s.id === "claude-code")!;
    const rev = cc.agents.find((a) => a.name === "code-reviewer")!;
    expect(rev.tools).toEqual(["read", "grep", "find", "bash", "mcp__github__get_pr"]);
    expect(rev.systemPrompt).toBe("You review code.");
    expect(rev.notes.join(" ")).toMatch(/WebFetch/);
    expect(rev.notes.join(" ")).toMatch(/sonnet/);
    // no tools list → all tools; name made safe
    expect(cc.agents.find((a) => a.name === "all-tools")).toMatchObject({ tools: undefined });
  });

  it("OpenCode: tools map with false entries, markdown and opencode.json agents", async () => {
    put(join(proj, ".opencode/agent/review.md"), `---\ndescription: Review only\nmode: subagent\ntools:\n  write: false\n  edit: false\n  bash: false\n---\nLook, don't touch.\n`);
    put(join(proj, "opencode.json"), JSON.stringify({ agent: { docs: { description: "Writes docs", prompt: "You write docs.", tools: { task: true } } } }));
    const oc = (await ai.findAgentImportSources(proj)).find((s) => s.id === "project-opencode")!;
    expect(oc.agents.find((a) => a.name === "review")).toMatchObject({ tools: ["read", "grep", "find", "ls"], systemPrompt: "Look, don't touch." });
    expect(oc.agents.find((a) => a.name === "docs")).toMatchObject({ tools: undefined, canSpawn: true, systemPrompt: "You write docs." });
  });

  it("imports into pi's agents folder", async () => {
    const { featureOps } = await import("./ops/features.ts");
    const { ops } = featureOps({ guiDir: join(home, ".pi-gui") } as never);
    const r = (await ops["agents.import"]!({ source: "claude-code", names: ["code-reviewer"], scope: "project", project: proj }, {} as never)) as { added: string[] };
    expect(r.added).toEqual(["code-reviewer"]);
    const { loadAgents } = await import("./agents.ts");
    const a = (await loadAgents(proj)).agents.find((x) => x.name === "code-reviewer")!;
    expect(a).toMatchObject({ scope: "project", tools: ["read", "grep", "find", "bash", "mcp__github__get_pr"], systemPrompt: "You review code." });
    // second time: skipped unless overwrite
    const again = (await ops["agents.import"]!({ source: "claude-code", names: ["code-reviewer"], scope: "project", project: proj }, {} as never)) as { skipped: string[] };
    expect(again.skipped).toEqual(["code-reviewer"]);
  });
});
