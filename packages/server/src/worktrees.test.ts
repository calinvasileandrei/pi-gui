import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createWorktree, listWorktrees, parseWorktreeList, removeWorktree, repoOf, suggestPath } from "./worktrees.ts";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
  const r = join(base, "app");
  mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, ".gitignore"), ".env*\n!.env.example\n");
  writeFileSync(join(r, "a.txt"), "a\n");
  writeFileSync(join(r, ".env"), "SECRET=1\n");
  writeFileSync(join(r, ".env.example"), "SECRET=\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "init");
  return r;
}

describe("worktrees", () => {
  it("parses porcelain output", () => {
    const out = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r2\nHEAD def\ndetached\nlocked reason\n\nworktree /gone\nHEAD 123\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n";
    expect(parseWorktreeList(out)).toEqual([
      { path: "/r", head: "abc", branch: "main" },
      { path: "/r2", head: "def", detached: true, locked: "reason" },
      { path: "/gone", head: "123", branch: "x", prunable: "gitdir file points to non-existent location" },
    ]);
  });

  it("suggests a folder next to existing worktrees, else <repo>.worktrees/", () => {
    expect(suggestPath("/c/app", ["/c/app"], "feat/login")).toBe("/c/app.worktrees/feat-login");
    expect(suggestPath("/c/app", ["/c/app", "/w/app/one"], "two")).toBe("/w/app/two");
    expect(suggestPath("/c/app", ["/c/app", "/c/app-one"], "two")).toBe("/c/app-two");
    expect(suggestPath("/c/app", ["/c/app"], "x", "/saved")).toBe("/saved/x");
  });

  it("creates, lists, copies .env, and removes with safety checks", async () => {
    const r = repo();
    const path = suggestPath(r, [r], "feat/login");
    const c = await createWorktree({ repo: r, branch: "feat/login", base: "main", path, copy: [".env*"] });
    expect(c.copied).toEqual([".env"]); // .env.example is tracked → came with the checkout
    expect(readFileSync(join(c.path, ".env"), "utf8")).toBe("SECRET=1\n");

    // from inside the worktree we still find the repo
    expect((await repoOf(c.path))?.main).toBe(r);
    let l = (await listWorktrees(c.path))!;
    expect(l.repo).toBe(r);
    expect(l.current).toBe(c.path);
    expect(l.defaultBranch).toBe("main");
    expect(l.worktrees.map((w) => [basename(w.path), w.branch, w.main])).toEqual([
      ["app", "main", true],
      ["feat-login", "feat/login", false],
    ]);
    const wt = l.worktrees[1]!;
    expect(wt).toMatchObject({ dirty: 0, merged: true, unique: 0 });

    await expect(createWorktree({ repo: r, branch: "feat/login", path: join(dirname(path), "dup") })).rejects.toThrow(/already exists/);
    await expect(removeWorktree({ path: r })).rejects.toThrow(/main checkout/);

    // a commit + an uncommitted change
    writeFileSync(join(c.path, "b.txt"), "b\n");
    g(c.path, "add", "b.txt");
    g(c.path, "commit", "-qm", "b");
    writeFileSync(join(c.path, "a.txt"), "changed\n");
    l = (await listWorktrees(r))!;
    expect(l.worktrees[1]).toMatchObject({ dirty: 1, merged: false, unique: 1 });
    await expect(removeWorktree({ path: c.path })).rejects.toThrow(/uncommitted/);
    // unmerged branch: plain delete refuses, force deletes
    await expect(removeWorktree({ path: c.path, force: false, deleteBranch: true })).rejects.toThrow();
    const done = await removeWorktree({ path: c.path, force: true, deleteBranch: true });
    expect(done.branchDeleted).toBe("feat/login");
    expect(existsSync(c.path)).toBe(false);
    expect(g(r, "branch", "--list", "feat/login").trim()).toBe("");
  });

  it("checks out an existing branch", async () => {
    const r = repo();
    g(r, "branch", "fix-1");
    const c = await createWorktree({ repo: r, branch: "fix-1", existing: true, path: join(dirname(r), "fix-1") });
    expect(g(c.path, "branch", "--show-current").trim()).toBe("fix-1");
    await expect(createWorktree({ repo: r, branch: "bad..name", path: join(dirname(r), "bad") })).rejects.toThrow(/valid branch/);
  });
});
