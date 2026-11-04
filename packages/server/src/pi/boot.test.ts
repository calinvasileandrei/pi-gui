import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePiBoot } from "./adapter.ts";

describe("pi bootstrap", () => {
  it("hides GUI-private env from pi's children, keeps it in-process, preserves argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "piboot-"));
    const boot = writePiBoot(dir);
    // stand-in for pi's cli.js: reports what it sees and what a spawned tool would see
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      `import { execSync } from "node:child_process";
       console.log(JSON.stringify({
         argv1: process.argv[1], rest: process.argv.slice(2),
         inProcToken: globalThis.__piGui?.token, url: process.env.PI_GUI_URL,
         childEnv: execSync("env", { encoding: "utf8" }),
       }));`,
    );
    const out = JSON.parse(
      execFileSync(process.execPath, [boot, probe, "--mode", "rpc"], {
        encoding: "utf8",
        env: { ...process.env, PI_GUI_TOKEN: "s3cret", ELECTRON_RUN_AS_NODE: "1", PI_GUI_URL: "http://127.0.0.1:1" },
      }),
    );
    expect(out.argv1).toBe(probe);
    expect(out.rest).toEqual(["--mode", "rpc"]);
    expect(out.inProcToken).toBe("s3cret");
    expect(out.url).toBe("http://127.0.0.1:1");
    expect(out.childEnv).not.toContain("s3cret");
    expect(out.childEnv).not.toContain("ELECTRON_RUN_AS_NODE");
  });
});
