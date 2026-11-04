import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const fixture = resolve(__dirname, "../test/mcp-echo.mjs");
let m: typeof import("./mcp.ts");

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = tmp("mcp-agent-"); // keep the user's real ~/.pi/agent/mcp.json out of it
  m = await import("./mcp.ts");
});

describe("mcp config", () => {
  it("project overrides global by name; invalid entries are reported", async () => {
    const proj = tmp("mcp-proj-");
    await m.saveServer("global", undefined, "shared", { command: "global-cmd" });
    await m.saveServer("global", undefined, "only-global", { url: "https://x.test/mcp" });
    await m.saveServer("project", proj, "shared", { command: "project-cmd", args: [] });
    const { servers } = await m.loadMcpConfig(proj);
    expect(servers.find((s) => s.name === "shared")).toMatchObject({ scope: "project", config: { command: "project-cmd" } });
    expect(servers.find((s) => s.name === "only-global")?.scope).toBe("global");
    // empty args dropped, file is private
    expect(JSON.parse(readFileSync(m.mcpFile("project", proj), "utf8")).mcpServers.shared).toEqual({ command: "project-cmd" });
    await expect(m.saveServer("project", proj, "bad name!", { command: "x" })).rejects.toThrow(/server name/);
    await expect(m.saveServer("project", proj, "nothing", {} as never)).rejects.toThrow(/command|url/);
  });

  it("expands ${VAR}", () => {
    expect(m.expandVars("Bearer ${TOK} ${env:TOK}", { TOK: "abc" })).toBe("Bearer abc abc");
    expect(m.expandVars("${MISSING}x", {})).toBe("x");
  });

  it("maps MCP results to pi content", () => {
    expect(m.toPiContent({ content: [{ type: "text", text: "hi" }, { type: "image", data: "AAA", mimeType: "image/png" }] }).content).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/png" },
    ]);
    expect(m.toPiContent({ content: [], structuredContent: { a: 1 } }).content[0]).toMatchObject({ type: "text" });
    expect(m.toPiContent({ isError: true, content: [{ type: "text", text: "x" }] }).isError).toBe(true);
  });
});

describe("McpManager (real stdio server)", () => {
  const proj = tmp("mcp-live-");
  const changes: string[] = [];
  let mgr: InstanceType<typeof m.McpManager>;
  beforeAll(async () => {
    mgr = new m.McpManager({ onChange: (r) => changes.push(r), liveRoots: () => new Set([proj]) });
    process.env.PI_GUI_TOKEN = "secret-should-not-leak";
    await m.saveServer("project", proj, "echo", { command: process.execPath, args: [fixture], env: { FOO: "${MCP_TEST_FOO}" } });
    process.env.MCP_TEST_FOO = "bar";
  });
  afterAll(() => mgr.closeAll());

  it("connects, lists tools, calls them, scrubs the GUI token", async () => {
    const r = await mgr.toolsFor(proj, 20_000);
    expect(r.tools.map((t) => t.name).sort()).toEqual(["mcp__echo__boom", "mcp__echo__echo", "mcp__echo__whereami"]); // global "shared"/"only-global" fail to start and contribute nothing
    expect(r.instructions[0]).toMatch(/repeat text/);
    const echo = await mgr.call(proj, "echo", "echo", { text: "hello" });
    expect(m.toPiContent(echo as never).content[0]).toEqual({ type: "text", text: "echo: hello" });
    const where = m.toPiContent((await mgr.call(proj, "echo", "whereami", {})) as never).content[0] as { text: string };
    expect(where.text).toBe(`${proj}|bar|no-token`);
    expect(m.toPiContent((await mgr.call(proj, "echo", "boom", {})) as never).isError).toBe(true);
    const st = await mgr.status(proj);
    const echoS = st.servers.find((x) => x.name === "echo")!;
    expect(echoS).toMatchObject({ name: "echo", status: "connected", serverName: "echo-test", serverVersion: "1.2.3" });
    expect(echoS.tools.find((t) => t.name === "echo")?.readOnly).toBe(true);
  }, 30_000);

  it("disabled tools are hidden and refused; config changes reconnect", async () => {
    await m.patchServer("project", proj, "echo", { disabledTools: ["boom"] });
    await mgr.reconcile(proj);
    const r = await mgr.toolsFor(proj);
    expect(r.tools.map((t) => t.name)).not.toContain("mcp__echo__boom");
    await expect(mgr.call(proj, "echo", "boom", {})).rejects.toThrow(/disabled/);

    await m.patchServer("project", proj, "echo", { env: { FOO: "changed" } });
    await mgr.reconcile(proj);
    expect((await mgr.status(proj)).servers.find((x) => x.name === "echo")!.status).toBe("idle"); // old connection dropped
    await mgr.toolsFor(proj, 20_000);
    const where = m.toPiContent((await mgr.call(proj, "echo", "whereami", {})) as never).content[0] as { text: string };
    expect(where.text).toContain("|changed|");
  }, 30_000);

  it("reports a missing command clearly", async () => {
    await m.saveServer("project", proj, "nope", { command: "definitely-not-a-real-binary-xyz" });
    await mgr.toolsFor(proj, 20_000);
    const s = (await mgr.status(proj)).servers.find((x) => x.name === "nope");
    expect(s?.status).toBe("error");
    expect(s?.error).toMatch(/not found|ENOENT/);
  }, 30_000);
});
