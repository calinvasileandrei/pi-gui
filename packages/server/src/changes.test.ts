import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeTracker, applyEdits, parsePorcelain } from "./changes.ts";

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chg-")));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  writeFileSync(join(dir, "b.txt"), "bee\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return dir;
}
const tracker = () => new ChangeTracker(() => {}, () => {}, () => {});

describe("ChangeTracker (git)", () => {
  it("lists modified/untracked/deleted with numstat and marks agent-touched files", async () => {
    const dir = repo();
    const t = tracker();
    await t.beforeWrite("s1", dir, "edit", "a.ts", {});
    writeFileSync(join(dir, "a.ts"), "const a = 2;\nconst b = 3;\n");
    writeFileSync(join(dir, "new.md"), "# hi\n");
    execFileSync("rm", [join(dir, "b.txt")]);
    const info = await t.list("s1", dir);
    expect(info.git).toBe(true);
    const by = Object.fromEntries(info.files.map((f) => [f.path, f]));
    expect(by["a.ts"]).toMatchObject({ status: "modified", agent: true, additions: 2, deletions: 1 });
    expect(by["new.md"]).toMatchObject({ status: "untracked", agent: false });
    expect(by["b.txt"]).toMatchObject({ status: "deleted" });
    expect(info.files[0]!.path).toBe("a.ts"); // agent files first
  });

  it("diffs against HEAD and against the pre-edit snapshot", async () => {
    const dir = repo();
    const t = tracker();
    writeFileSync(join(dir, "a.ts"), "const a = 'user';\n"); // user's own uncommitted change
    await t.beforeWrite("s1", dir, "edit", join(dir, "a.ts"), {});
    writeFileSync(join(dir, "a.ts"), "const a = 'agent';\n");
    const head = await t.diff("s1", dir, "a.ts", "head");
    expect(head).toMatchObject({ original: "const a = 1;\n", modified: "const a = 'agent';\n", language: "typescript", base: "head" });
    const agent = await t.diff("s1", dir, "a.ts", "agent");
    expect(agent.original).toBe("const a = 'user';\n");
  });

  it("reverts to the snapshot (keeping the user's own change) or to HEAD; new files go to trash", async () => {
    const dir = repo();
    const trash = mkdtempSync(join(tmpdir(), "trash-"));
    const t = tracker();
    writeFileSync(join(dir, "a.ts"), "user\n");
    await t.beforeWrite("s1", dir, "edit", "a.ts", {});
    writeFileSync(join(dir, "a.ts"), "agent\n");
    await t.revert("s1", dir, "a.ts", "agent", trash);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("user\n");
    await t.revert("s1", dir, "a.ts", "head", trash);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const a = 1;\n");
    writeFileSync(join(dir, "n.txt"), "x");
    await t.revert("s1", dir, "n.txt", "head", trash);
    expect(existsSync(join(dir, "n.txt"))).toBe(false);
    expect(execFileSync("ls", [trash]).toString()).toContain("n.txt");
  });
});

describe("ChangeTracker (no git)", () => {
  it("tracks agent edits from snapshots alone", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nogit-")));
    writeFileSync(join(dir, "x.js"), "old\n");
    const t = tracker();
    await t.beforeWrite("s", dir, "write", "x.js", {});
    await t.beforeWrite("s", dir, "write", "y.js", {});
    writeFileSync(join(dir, "x.js"), "new\n");
    writeFileSync(join(dir, "y.js"), "created\n");
    const info = await t.list("s", dir);
    expect(info.git).toBe(false);
    expect(info.files.map((f) => [f.path, f.status])).toEqual([["x.js", "modified"], ["y.js", "added"]]);
    expect((await t.diff("s", dir, "x.js", "head")).original).toBe("old\n"); // falls back to snapshot
  });
});

describe("approvals", () => {
  it("blocks the tool until the user decides, with a preview of the result", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "appr-")));
    writeFileSync(join(dir, "f.txt"), "hello world\n");
    let seen: any;
    const t = new ChangeTracker(() => {}, (r) => (seen = r), () => {});
    t.approvalMode.add("s");
    const p = t.beforeWrite("s", dir, "edit", "f.txt", { edits: [{ oldText: "world", newText: "pi" }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.proposed).toBe("hello pi\n");
    t.decide(seen.id, false, "wrong file");
    expect(await p).toEqual({ block: true, reason: "User rejected this change: wrong file" });
  });

  it("applyEdits mirrors pi's edit semantics", () => {
    expect(applyEdits("a b c", [{ oldText: "b", newText: "B" }, { oldText: "c", newText: "C" }])).toBe("a B C");
    expect(applyEdits("abc", [{ oldText: "zz", newText: "" }])).toBeUndefined();
  });

  it("parsePorcelain handles renames", () => {
    expect(parsePorcelain("R  new.ts\0old.ts\0?? u.txt\0")).toMatchObject([
      { path: "new.ts", oldPath: "old.ts", status: "renamed", agent: false },
      { path: "u.txt", oldPath: undefined, status: "untracked", agent: false },
    ]);
  });
});
