import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyIn, createEntry, inside, listDir, movePaths, openFile, renameEntry, saveFile, trashEntries } from "./files.ts";
import { ChangeTracker, gitCommit, gitStage } from "./changes.ts";

const tmp = (p = "fs-") => realpathSync(mkdtempSync(join(tmpdir(), p)));

describe("files", () => {
  it("confines paths to the root", () => {
    const r = tmp();
    expect(inside(r, "a/b")).toBe(join(r, "a/b"));
    expect(inside(r, "")).toBe(r);
    expect(() => inside(r, "../x")).toThrow(/outside/);
    expect(() => inside(r, "/etc/passwd")).toThrow(/outside/);
  });

  it("lists folders first, hides .git, marks gitignored", async () => {
    const r = tmp();
    execFileSync("git", ["init", "-q"], { cwd: r });
    writeFileSync(join(r, ".gitignore"), "dist/\n*.log\n");
    mkdirSync(join(r, "src"));
    mkdirSync(join(r, "dist"));
    writeFileSync(join(r, "b.ts"), "");
    writeFileSync(join(r, "x.log"), "");
    const l = await listDir(r, "");
    expect(l.map((e) => e.name)).toEqual(["dist", "src", ".gitignore", "b.ts", "x.log"]);
    expect(l.find((e) => e.name === "dist")?.ignored).toBe(true);
    expect(l.find((e) => e.name === "x.log")?.ignored).toBe(true);
    expect(l.find((e) => e.name === "src")?.ignored).toBeUndefined();
  });

  it("moves, refuses overwrite and moving a folder into itself", async () => {
    const r = tmp();
    mkdirSync(join(r, "a/inner"), { recursive: true });
    mkdirSync(join(r, "b"));
    writeFileSync(join(r, "f.txt"), "hi");
    expect(await movePaths(r, ["f.txt"], "b")).toEqual(["b/f.txt"]);
    expect(readFileSync(join(r, "b/f.txt"), "utf8")).toBe("hi");
    await expect(movePaths(r, ["a"], "a/inner")).rejects.toThrow(/into itself/);
    writeFileSync(join(r, "f.txt"), "again");
    await expect(movePaths(r, ["f.txt"], "b")).rejects.toThrow(/already exists/);
  });

  it("copies in from outside, creates, renames, trashes", async () => {
    const r = tmp();
    const outside = tmp("src-");
    mkdirSync(join(outside, "pkg"));
    writeFileSync(join(outside, "pkg/i.js"), "1");
    expect(await copyIn(r, [join(outside, "pkg")], "")).toEqual(["pkg"]);
    expect(existsSync(join(r, "pkg/i.js"))).toBe(true);
    expect(await createEntry(r, "pkg/new.ts", false)).toBe("pkg/new.ts");
    expect(await renameEntry(r, "pkg/new.ts", "renamed.ts")).toBe("pkg/renamed.ts");
    const trash = tmp("trash-");
    await trashEntries(r, ["pkg"], trash);
    expect(existsSync(join(r, "pkg"))).toBe(false);
  });

  it("opens and saves with a stale-write guard", async () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "x");
    const f = await openFile(r, "a.ts");
    expect(f).toMatchObject({ text: "x", language: "typescript", binary: false });
    const s = await saveFile(r, "a.ts", "y", f.mtimeMs);
    await new Promise((x) => setTimeout(x, 20));
    writeFileSync(join(r, "a.ts"), "external");
    await expect(saveFile(r, "a.ts", "z", s.mtimeMs)).rejects.toThrow(/changed on disk/);
  });
});

describe("git panel", () => {
  it("reports staged/unstaged, stages and commits", async () => {
    const r = tmp("git-");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: r, stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(r, "a.txt"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    writeFileSync(join(r, "a.txt"), "2\n");
    writeFileSync(join(r, "n.txt"), "new\n");
    const t = new ChangeTracker(() => {}, () => {}, () => {});
    let info = await t.list([], r);
    expect(info.files.find((f) => f.path === "a.txt")).toMatchObject({ staged: false, unstaged: true });
    await gitStage(r, ["a.txt"], true);
    info = await t.list([], r);
    expect(info.files.find((f) => f.path === "a.txt")).toMatchObject({ staged: true, unstaged: false });
    await gitStage(r, ["a.txt"], false);
    info = await t.list([], r);
    expect(info.files.find((f) => f.path === "a.txt")?.staged).toBe(false);
    const c = await gitCommit(r, "all of it", true);
    expect(c.hash).toMatch(/^[0-9a-f]+$/);
    expect((await t.list([], r)).files).toEqual([]);
  });
});
