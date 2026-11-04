import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Channel, ClientMessage, ServerMessage } from "@pi-gui/protocol";
import type { Bus } from "./bus.ts";

export type OpHandler = (args: any, ctx: OpContext) => unknown | Promise<unknown>;
export interface OpContext {
  /** "ws" from the browser, "http" from the gui-bridge extension */
  via: "ws" | "http";
  /** for http: the calling pi session (from header) */
  callerSession?: string;
  /** fires if the caller goes away (parent pi aborted the tool call) */
  signal?: AbortSignal;
}

export interface ServerOptions {
  host: string; // always 127.0.0.1
  port: number;
  token: string;
  bus: Bus;
  ops: Record<string, OpHandler>;
  /** hot paths that bypass req/res */
  ptyInput: (id: string, data: string) => void;
  ptyResize: (id: string, cols: number, rows: number) => void;
  staticDir?: string;
  /** extra allowed browser origins (vite dev server) */
  extraOrigins?: string[];
  /** ops the extension may call over HTTP */
  httpOps: Set<string>;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ttf": "font/ttf",
};

export function startServer(o: ServerOptions) {
  // recomputed after listen() so port 0 (pick a free port) works
  let selfOrigins = new Set<string>();
  let okHosts = new Set<string>();
  const setPort = (port: number) => {
    selfOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(o.extraOrigins ?? [])]);
    okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  };
  setPort(o.port);

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: only answer requests addressed to loopback names.
    if (!okHosts.has(req.headers.host ?? "")) return send(res, 421, "bad host");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (o.staticDir) return await serveStatic(res, url.pathname);
      send(res, 404, "not found");
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const auth = req.headers.authorization ?? "";
    if (!safeEq(auth, `Bearer ${o.token}`)) return send(res, 401, "unauthorized");
    // Browsers attach Origin to cross-site requests; reject any that aren't ours.
    const origin = req.headers.origin;
    if (origin && !selfOrigins.has(origin)) return send(res, 403, "bad origin");
    if (req.method !== "POST") return send(res, 405, "POST only");
    const op = url.pathname.slice("/api/".length);
    if (!o.httpOps.has(op) || !o.ops[op]) return send(res, 404, `unknown op ${op}`);
    const body = await readBody(req, 4 * 1024 * 1024);
    const args = body ? JSON.parse(body) : {};
    const callerSession = req.headers["x-pi-gui-session"];
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const data = await o.ops[op]!(args, { via: "http", callerSession: typeof callerSession === "string" ? callerSession : undefined, signal: ac.signal });
      json(res, 200, { ok: true, data });
    } catch (e) {
      json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  async function serveStatic(res: ServerResponse, pathname: string) {
    const root = resolve(o.staticDir!);
    let p = normalize(join(root, decodeURIComponent(pathname)));
    if (p !== root && !p.startsWith(root + sep)) return send(res, 403, "forbidden");
    const st = await stat(p).catch(() => null);
    if (!st || st.isDirectory()) p = join(root, "index.html"); // SPA fallback
    const body = await readFile(p).catch(() => null);
    if (!body) return send(res, 404, "UI not built — run `pnpm build` or use `pnpm dev`");
    res.writeHead(200, {
      "content-type": MIME[extname(p)] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  }

  // ---- WebSocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const origin = req.headers.origin ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname !== "/ws" || !okHosts.has(req.headers.host ?? "") || !selfOrigins.has(origin) || !safeEq(token, o.token)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const unsubs = new Set<() => void>();
  function onConnection(ws: WebSocket) {
    const subs = new Set<Channel>();
    const out = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const unsub = o.bus.onPublish((ch, e) => {
      if (subs.has(ch)) out({ t: "evt", ch, seq: e.seq, data: e.data });
    });
    unsubs.add(unsub);
    ws.on("close", () => {
      unsub();
      unsubs.delete(unsub);
    });

    ws.on("message", async (raw) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (m.t) {
        case "sub": {
          subs.add(m.ch);
          const entries = o.bus.replay(m.ch, m.since);
          if (entries === null) {
            out({ t: "reset", ch: m.ch });
            return;
          }
          for (const e of entries) out({ t: "evt", ch: m.ch, seq: e.seq, data: e.data });
          return;
        }
        case "unsub":
          subs.delete(m.ch);
          return;
        case "pty_in":
          o.ptyInput(m.id, m.data);
          return;
        case "pty_resize":
          o.ptyResize(m.id, m.cols, m.rows);
          return;
        case "req": {
          const h = o.ops[m.op];
          if (!h) return out({ t: "res", id: m.id, ok: false, error: `unknown op ${m.op}` });
          try {
            const data = await h(m.args ?? {}, { via: "ws" });
            out({ t: "res", id: m.id, ok: true, data });
          } catch (e) {
            out({ t: "res", id: m.id, ok: false, error: (e as Error).message });
          }
          return;
        }
      }
    });
  }

  return new Promise<{ close: () => Promise<void>; url: string; port: number }>((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      const port = (server.address() as AddressInfo).port;
      setPort(port);
      resolveStart({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            for (const u of unsubs) u();
            for (const c of wss.clients) c.terminate();
            server.close(() => r());
          }),
      });
    });
  });
}

function send(res: ServerResponse, code: number, text: string) {
  res.writeHead(code, { "content-type": "text/plain" });
  res.end(text);
}
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
