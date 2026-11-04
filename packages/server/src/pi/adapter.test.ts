import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { RpcEvent } from "@pi-gui/protocol";
import { PiProcess } from "./adapter.ts";

const FAKE = fileURLToPath(new URL("../../test/fake-pi.mjs", import.meta.url));
const procs: PiProcess[] = [];
function fake() {
  const p = new PiProcess({ cwd: process.cwd(), piCommand: [process.execPath, FAKE], env: { FAKE_PI_DELAY: "1" } });
  procs.push(p);
  p.start();
  return p;
}
function until(p: PiProcess, type: string): Promise<RpcEvent> {
  return new Promise((r) => {
    const h = (e: RpcEvent) => {
      if (e.type === type) {
        p.off("event", h);
        r(e);
      }
    };
    p.on("event", h);
  });
}
afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.stop(500)));
});

describe("PiProcess (contract, fake pi)", () => {
  it("correlates responses by id", async () => {
    const p = fake();
    const [s, m] = await Promise.all([p.getState(), p.getModels()]);
    expect(s.sessionId).toBe("fake-session");
    expect(m.models.length).toBe(2);
  });

  it("surfaces success:false as a thrown error via call()", async () => {
    const p = fake();
    await expect(p.setModel("nope", "x")).rejects.toThrow(/Model not found/);
  });

  it("streams events for a prompt through agent_end", async () => {
    const p = fake();
    const events: RpcEvent[] = [];
    p.on("event", (e) => events.push(e));
    const end = until(p, "agent_end");
    await p.prompt("hello world");
    await end;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types).toContain("message_update");
    expect(types.at(-1)).toBe("agent_end");
  });

  it("round-trips extension UI dialogs", async () => {
    const p = fake();
    const req = until(p, "extension_ui_request");
    const end = until(p, "agent_end");
    await p.prompt("ask");
    const r = (await req) as Extract<RpcEvent, { type: "extension_ui_request" }>;
    p.respondUi({ type: "extension_ui_response", id: r.id, confirmed: true });
    const e = (await end) as Extract<RpcEvent, { type: "agent_end" }>;
    expect(JSON.stringify(e.messages)).toContain("answer: true");
  });

  it("reports a crash with stderr tail and rejects pending requests", async () => {
    const p = fake();
    const exit = p.waitForExit();
    await p.prompt("crash");
    const info = await exit;
    expect(info.code).toBe(3);
    expect(info.expected).toBe(false);
    expect(info.stderrTail).toContain("simulated crash");
    await expect(p.getState()).rejects.toThrow(/not running/);
  });

  it("stop() is marked expected", async () => {
    const p = fake();
    await p.getState();
    const info = await p.stop(500);
    expect(info?.expected).toBe(true);
  });
});
