import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import WebSocket from "ws";
import type { ServerMessage } from "@pi-gui/protocol";
import { Bus } from "./bus.ts";
import { startServer } from "./http.ts";
import { Supervisor } from "./sessions.ts";
import { sessionOps } from "./ops/sessions.ts";

const FAKE = fileURLToPath(new URL("../test/fake-pi.mjs", import.meta.url));
const PORT = 45170 + Math.floor(Math.random() * 500);
const TOKEN = "test-token-abc";
const ORIGIN = `http://127.0.0.1:${PORT}`;
let close: () => Promise<void>;
let sup: Supervisor;

beforeAll(async () => {
  const bus = new Bus();
  sup = new Supervisor({ bus, piCommand: [process.execPath, FAKE], baseEnv: () => ({ FAKE_PI_DELAY: "1" }) });
  const srv = await startServer({
    host: "127.0.0.1",
    port: PORT,
    token: TOKEN,
    bus,
    ops: { ...sessionOps(sup, bus), "ext.ping": () => "pong" },
    httpOps: new Set(["ext.ping"]),
    ptyInput: () => {},
    ptyResize: () => {},
  });
  close = srv.close;
});
afterAll(async () => {
  await sup.stopAll();
  await close();
});

function connect(opts: { token?: string; origin?: string } = {}) {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${opts.token ?? TOKEN}`, { origin: opts.origin ?? ORIGIN });
}
function opened(ws: WebSocket) {
  return new Promise<boolean>((r) => {
    ws.on("open", () => r(true));
    ws.on("error", () => r(false));
  });
}
function client(ws: WebSocket) {
  let n = 0;
  const msgs: ServerMessage[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  const req = (op: string, args?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = `r${++n}`;
      const h = (d: WebSocket.RawData) => {
        const m = JSON.parse(d.toString()) as ServerMessage;
        if (m.t === "res" && m.id === id) {
          ws.off("message", h);
          m.ok ? resolve(m.data) : reject(new Error(m.error));
        }
      };
      ws.on("message", h);
      ws.send(JSON.stringify({ t: "req", id, op, args }));
    });
  return { req, msgs };
}
function httpPost(path: string, headers: Record<string, string>, body = "{}") {
  return new Promise<{ status: number; body: string }>((resolve) => {
    const r = request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    r.end(body);
  });
}

describe("security", () => {
  it("rejects WS with wrong token", async () => expect(await opened(connect({ token: "nope" }))).toBe(false));
  it("rejects WS from a foreign origin", async () => expect(await opened(connect({ origin: "https://evil.example" }))).toBe(false));
  it("accepts WS with token + own origin", async () => {
    const ws = connect();
    expect(await opened(ws)).toBe(true);
    ws.close();
  });
  it("rejects HTTP without token", async () => expect((await httpPost("/api/ext.ping", {})).status).toBe(401));
  it("rejects HTTP with foreign Origin", async () =>
    expect((await httpPost("/api/ext.ping", { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status).toBe(403));
  it("rejects non-loopback Host (DNS rebinding)", async () =>
    expect((await httpPost("/api/ext.ping", { authorization: `Bearer ${TOKEN}`, host: "evil.example" })).status).toBe(421));
  it("only exposes allow-listed ops over HTTP", async () => {
    const h = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    expect(JSON.parse((await httpPost("/api/ext.ping", h)).body)).toEqual({ ok: true, data: "pong" });
    expect((await httpPost("/api/session.create", h)).status).toBe(404);
  });
});

describe("ws api", () => {
  it("creates a session, prompts, streams events, and replays after reconnect", async () => {
    const ws = connect();
    await opened(ws);
    const c = client(ws);
    const info = await c.req("session.create", { cwd: process.cwd(), name: "ws-test" });
    expect(info.status).toBe("idle");
    const ch = `session:${info.id}`;
    ws.send(JSON.stringify({ t: "sub", ch }));
    await c.req("session.prompt", { id: info.id, message: "hello ws" });
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (c.msgs.some((m) => m.t === "evt" && m.data.kind === "rpc" && m.data.record.type === "agent_end")) {
          clearInterval(t);
          r();
        }
      }, 10);
    });
    ws.close();

    // reconnect: snapshot + replay since its seq yields no duplicates
    const ws2 = connect();
    await opened(ws2);
    const c2 = client(ws2);
    const snap = await c2.req("session.snapshot", { id: info.id });
    expect(snap.messages.at(-1).content[0].text).toBe("echo: hello ws");
    const before = c2.msgs.length;
    ws2.send(JSON.stringify({ t: "sub", ch, since: snap.seq }));
    await new Promise((r) => setTimeout(r, 50));
    const replayed = c2.msgs.slice(before).filter((m) => m.t === "evt" && m.data.kind === "rpc");
    expect(replayed).toHaveLength(0);
    ws2.close();
  });

  it("returns errors for unknown ops and bad args", async () => {
    const ws = connect();
    await opened(ws);
    const c = client(ws);
    await expect(c.req("nope")).rejects.toThrow(/unknown op/);
    await expect(c.req("session.create", { cwd: "/definitely/not/here" })).rejects.toThrow(/not a directory/);
    ws.close();
  });
});

describe("session.bash", () => {
  it("runs a shell command in the session and returns output + exit code", async () => {
    const ws = connect();
    await opened(ws);
    const c = client(ws);
    const info = await c.req("session.create", { cwd: process.cwd() });
    expect(await c.req("session.bash", { id: info.id, command: "echo hi-from-bash" })).toMatchObject({ output: "hi-from-bash\n", exitCode: 0 });
    expect((await c.req("session.bash", { id: info.id, command: "exit 7" })).exitCode).toBe(7);
    ws.close();
  });
});
