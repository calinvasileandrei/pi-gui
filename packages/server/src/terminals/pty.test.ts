import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import type { ChannelEvent } from "@pi-gui/protocol";
import { Bus } from "../bus.ts";
import { PtyManager, stripAnsi, type Terminal } from "./pty.ts";

let mgr: PtyManager;
afterEach(async () => {
  await mgr?.stopAll();
});

const output = (bus: Bus, t: Terminal) =>
  (bus.replay(t.channel) ?? []).map((e) => (e.data.kind === "pty_out" ? e.data.data : "")).join("");
const waitFor = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("PtyManager", () => {
  it("loads node-pty (real TTY)", () => {
    mgr = new PtyManager(new Bus());
    expect(mgr.pty).not.toBeNull();
  });

  it("runs a command in a login shell with a real TTY and records exit", async () => {
    const bus = new Bus();
    mgr = new PtyManager(bus);
    const t = mgr.open({ name: "t", cwd: tmpdir(), command: "test -t 1 && echo IS_TTY; echo PATH_OK=$([ -n \"$PATH\" ] && echo y)", profile: false });
    await waitFor(() => t.status === "exited");
    const out = stripAnsi(output(bus, t));
    expect(out).toContain("IS_TTY");
    expect(out).toContain("PATH_OK=y");
    expect(t.exitCode).toBe(0);
  });

  it("does not leak the GUI token into terminals", async () => {
    const bus = new Bus();
    mgr = new PtyManager(bus);
    process.env.PI_GUI_TOKEN = "secret-xyz";
    const t = mgr.open({ name: "t", cwd: tmpdir(), command: "echo TOKEN=[$PI_GUI_TOKEN]", profile: false });
    await waitFor(() => t.status === "exited");
    delete process.env.PI_GUI_TOKEN;
    expect(stripAnsi(output(bus, t))).toContain("TOKEN=[]");
  });

  it("accepts input (interactive keys) and stop() kills the whole group", async () => {
    const bus = new Bus();
    mgr = new PtyManager(bus);
    // child spawns a grandchild; reads a key like Metro's `r`
    const t = mgr.open({ name: "t", cwd: tmpdir(), command: "sleep 60 & echo GRAND=$!; read k; echo GOT_$k; sleep 60", profile: false });
    await waitFor(() => /GRAND=\d+/.test(output(bus, t)));
    const grand = Number(output(bus, t).match(/GRAND=(\d+)/)![1]);
    t.write("r\r");
    await waitFor(() => output(bus, t).includes("GOT_r"));
    await t.stop(1000);
    expect(t.status).toBe("stopped");
    await new Promise((r) => setTimeout(r, 50));
    expect(() => process.kill(grand, 0)).toThrow();
  });

  it("errors cleanly on a missing cwd", () => {
    mgr = new PtyManager(new Bus());
    const t = mgr.open({ name: "t", cwd: "/no/such/dir", command: "echo", profile: false });
    expect(t.status).toBe("error");
    expect(t.error).toMatch(/does not exist/);
  });

  it("readLines returns plain recent lines, handling \\r progress overwrites", async () => {
    const bus = new Bus();
    mgr = new PtyManager(bus);
    const t = mgr.open({ name: "t", cwd: tmpdir(), command: "printf 'a\\n\\033[31mred\\033[0m\\nprog 10%%\\rprog 100%%\\nlast\\n'", profile: false });
    await waitFor(() => t.status === "exited");
    const lines = t.readLines(50).filter((l) => l && !l.startsWith("[process"));
    expect(lines.slice(-4)).toEqual(["a", "red", "prog 100%", "last"].map((x) => x));
  });

  it("replays scrollback to a late subscriber", async () => {
    const bus = new Bus();
    mgr = new PtyManager(bus);
    const t = mgr.open({ name: "t", cwd: tmpdir(), command: "echo HISTORY_LINE", profile: false });
    await waitFor(() => t.status === "exited");
    const replay: ChannelEvent[] = bus.replay(t.channel)!.map((e) => e.data);
    expect(replay.some((e) => e.kind === "pty_out" && e.data.includes("HISTORY_LINE"))).toBe(true);
  });
});
