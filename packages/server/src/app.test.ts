import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startApp } from "./app.ts";
import { resolveShellEnv } from "./shell-env.ts";

const FAKE = fileURLToPath(new URL("../test/fake-pi.mjs", import.meta.url));

describe("startApp", () => {
  it("binds a free port when port=0 and enforces origin on the real port", async () => {
    process.env.PI_GUI_HOME = mkdtempSync(join(tmpdir(), "pigui-"));
    process.env.PI_GUI_PI_BIN = `${process.execPath} ${FAKE}`;
    const app = await startApp({ port: 0, log: () => {} });
    try {
      expect(app.port).toBeGreaterThan(0);
      const ok = await new Promise<boolean>((r) => {
        const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { origin: app.url });
        ws.on("open", () => (ws.close(), r(true)));
        ws.on("error", () => r(false));
      });
      expect(ok).toBe(true);
    } finally {
      await app.stop();
      delete process.env.PI_GUI_PI_BIN;
    }
  });
});

describe("resolveShellEnv", () => {
  it("returns the login shell's environment with a PATH", async () => {
    const env = await resolveShellEnv();
    expect(env).not.toBeNull();
    expect(env!.PATH).toMatch(/\/usr\/bin/);
    expect(env!.HOME).toBe(process.env.HOME);
  }, 15_000);
});
