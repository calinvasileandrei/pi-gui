import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Bus } from "./bus.ts";
import { Semaphore, Supervisor, type ManagedSession } from "./sessions.ts";

const FAKE = fileURLToPath(new URL("../test/fake-pi.mjs", import.meta.url));
let sup: Supervisor;
function make(restartOnCrash = false) {
  const bus = new Bus();
  sup = new Supervisor({ bus, piCommand: [process.execPath, FAKE], baseEnv: () => ({ FAKE_PI_DELAY: "1" }), restartOnCrash });
  return { bus, sup };
}
const waitStatus = (s: ManagedSession, st: string, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (s.status === st ? resolve() : Date.now() - t0 > ms ? reject(new Error(`still ${s.status}`)) : setTimeout(tick, 10));
    tick();
  });

afterEach(async () => {
  await sup?.stopAll();
});

describe("Supervisor", () => {
  it("starts a session to idle and publishes state + list", async () => {
    const { bus, sup } = make();
    const s = await sup.create({ cwd: process.cwd(), name: "t1" });
    expect(s.status).toBe("idle");
    expect(s.info().name).toBe("t1");
    const kinds = bus.replay(s.channel)!.map((e) => e.data.kind);
    expect(kinds).toContain("session_state");
    expect(bus.replay("app")!.at(-1)!.data).toMatchObject({ kind: "sessions" });
  });

  it("goes streaming → idle around a prompt", async () => {
    const { sup } = make();
    const s = await sup.create({ cwd: process.cwd() });
    await s.requireProc().prompt("hello there friend");
    await waitStatus(s, "streaming");
    await waitStatus(s, "idle");
    const msgs = await s.messages();
    expect(msgs.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("marks a crash and can restart cleanly", async () => {
    const { sup } = make();
    const s = await sup.create({ cwd: process.cwd() });
    await s.requireProc().prompt("crash");
    await waitStatus(s, "crashed");
    expect(s.exitInfo?.code).toBe(3);
    expect(s.exitInfo?.stderrTail).toContain("simulated crash");
    await s.restart();
    expect(s.status).toBe("idle");
    expect(s.exitInfo).toBeUndefined();
  });

  it("auto-restarts when restartOnCrash", async () => {
    const { sup } = make(true);
    const s = await sup.create({ cwd: process.cwd() });
    await s.requireProc().prompt("crash");
    await waitStatus(s, "crashed");
    await waitStatus(s, "idle", 4000);
  });

  it("stop() yields stopped, not crashed", async () => {
    const { sup } = make();
    const s = await sup.create({ cwd: process.cwd() });
    await s.stop();
    expect(s.status).toBe("stopped");
  });

  it("killAll leaves no live process", async () => {
    const { sup } = make();
    const a = await sup.create({ cwd: process.cwd() });
    const pid = a.proc!.pid!;
    sup.killAll();
    await a.proc!.waitForExit();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("process group", () => {
  it("stop() kills grandchildren (no orphans)", async () => {
    const { bus, sup } = make();
    const s = await sup.create({ cwd: process.cwd() });
    await s.requireProc().prompt("spawn");
    let gpid = 0;
    for (let i = 0; i < 100 && !gpid; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const m = bus.replay(s.channel)!.map((e) => (e.data.kind === "stderr" ? e.data.text : "")).join("").match(/grandchild:(\d+)/);
      if (m) gpid = Number(m[1]);
    }
    expect(gpid).toBeGreaterThan(0);
    await s.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(() => process.kill(gpid, 0)).toThrow();
  });
});

describe("Bus", () => {
  it("replays since a seq and signals gaps", () => {
    const bus = new Bus(() => ({ maxEntries: 3, maxBytes: 1e9 }));
    for (let i = 0; i < 5; i++) bus.publish("app", { kind: "toast", level: "info", message: String(i) });
    expect(bus.replay("app", 3)!.map((e) => e.seq)).toEqual([4, 5]);
    expect(bus.replay("app", 2)!.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(bus.replay("app", 1)).toBeNull();
    expect(bus.replay("app", 99)).toBeNull();
  });
});

describe("Semaphore", () => {
  it("caps concurrency", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    let third = false;
    const p = sem.acquire().then((r) => ((third = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    r1();
    await p;
    expect(third).toBe(true);
  });
});
