import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "piagent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const mod = await import("./stored-sessions.ts");

const dir = join(agentDir, "sessions", "--Users-me-proj--");
const file = join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl");
beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/Users/me/proj" },
    { type: "message", id: "a1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "Fix the login bug" }] } },
    { type: "message", id: "a2", parentId: "a1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "broken.jsonl"), "not json\n");
});

describe("stored sessions (pi session files)", () => {
  it("lists sessions with cwd, first message and counts; skips broken files", async () => {
    const all = await mod.listStoredSessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "abc", cwd: "/Users/me/proj", firstMessage: "Fix the login bug", messageCount: 2 });
    expect(await mod.listStoredSessions("/other")).toHaveLength(0);
  });

  it("renames by appending a session_info entry at the leaf", async () => {
    await mod.renameStoredSession(file, "Login fix");
    const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ type: "session_info", parentId: "a2", name: "Login fix" });
    expect((await mod.listStoredSessions())[0]!.name).toBe("Login fix");
  });

  it("refuses files outside the session store; delete moves to trash", async () => {
    await expect(mod.renameStoredSession("/etc/passwd", "x")).rejects.toThrow(/not a pi session file/);
    const trash = mkdtempSync(join(tmpdir(), "tr-"));
    await mod.trashStoredSession(file, trash);
    expect(await mod.listStoredSessions()).toHaveLength(0);
    expect(readdirSync(trash)[0]).toMatch(/abc\.jsonl$/);
  });
});
