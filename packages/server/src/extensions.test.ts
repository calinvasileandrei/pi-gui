import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "piext-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const ext = await import("./extensions.ts");

mkdirSync(join(agentDir, "extensions", "folder-ext"), { recursive: true });
writeFileSync(join(agentDir, "extensions", "solo.ts"), "export default () => {}");
writeFileSync(join(agentDir, "extensions", "folder-ext", "index.ts"), "export default () => {}");
writeFileSync(join(agentDir, "extensions", "README.md"), "not an extension");
const local = mkdtempSync(join(tmpdir(), "localext-"));
writeFileSync(join(local, "index.ts"), "export default function (pi) { /* hello */ }");

const settings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));

describe("extensions (pi resource rules)", () => {
  it("discovers auto extensions (files + folders with index), ignoring other files", async () => {
    const list = await ext.listExtensions(undefined, "/app/gui-bridge.ts");
    expect(list.map((e) => [e.name, e.source, e.enabled]).sort()).toEqual(
      [["folder-ext", "auto", true], ["gui-bridge", "settings", true], ["solo", "auto", true]].sort(),
    );
  });

  it("disables an auto extension with pi's -path override and re-enables it", async () => {
    const solo = (await ext.listExtensions(undefined)).find((e) => e.name === "solo")!;
    await ext.setExtensionEnabled(solo, false);
    expect(settings().extensions).toEqual(["-extensions/solo.ts"]);
    expect((await ext.listExtensions(undefined)).find((e) => e.name === "solo")!.enabled).toBe(false);
    await ext.setExtensionEnabled(solo, true);
    expect(settings().extensions).toBeUndefined();
  });

  it("adds a local extension, parks it when disabled, restores it when enabled", async () => {
    await ext.addExtension(local, "global");
    expect(settings().extensions).toEqual([local]);
    const e = (await ext.listExtensions(undefined)).find((x) => x.path === local)!;
    await ext.setExtensionEnabled(e, false);
    expect(settings().extensions).toBeUndefined();
    expect(settings().piGuiDisabledExtensions).toEqual([local]);
    expect((await ext.listExtensions(undefined)).find((x) => x.path === local)!.enabled).toBe(false);
    await ext.setExtensionEnabled(e, true);
    expect(settings().extensions).toEqual([local]);
  });

  it("inspects source before enabling", async () => {
    const r = await ext.inspectExtension(local);
    expect(r.files.map((f) => f.path)).toEqual(["index.ts"]);
    expect(r.mainContent).toContain("hello");
  });

  it("rejects non-git URLs", async () => {
    await expect(ext.fetchGitExtension("file:///etc; rm -rf /", agentDir)).rejects.toThrow(/unsupported/);
  });
});
