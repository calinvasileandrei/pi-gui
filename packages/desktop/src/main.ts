// Electron main process: owns the embedded pi-gui server and the app window.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, type RunningApp } from "@pi-gui/server/app";
import { applyShellEnv, resolveShellEnv } from "@pi-gui/server/shell-env";

const here = dirname(fileURLToPath(import.meta.url));
const dev = process.env.PI_GUI_DEV === "1";
// desktop dev uses its own ports (server 4518, Vite 5174) so it never collides with browser-mode `pnpm dev` (4517/5173)
const VITE = `http://127.0.0.1:${process.env.PI_GUI_VITE_PORT ?? 5174}`;
const DEV_SERVER_PORT = Number(process.env.PI_GUI_PORT ?? 4518);
const GUI_DIR = process.env.PI_GUI_HOME ?? join(homedir(), ".pi-gui");
const STATE_FILE = join(GUI_DIR, "window.json");

app.setName("pi");
// tests/automation: isolated profile (localStorage, window state) so they never touch the real app's
if (process.env.PI_GUI_USER_DATA) app.setPath("userData", process.env.PI_GUI_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let server: RunningApp | undefined;
let win: BrowserWindow | undefined;

// ---- window state ----
interface WinState { x?: number; y?: number; width: number; height: number; maximized?: boolean }
function loadState(): WinState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as WinState;
    // only restore a position that is still on a connected display
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x !== undefined && s.y !== undefined && s.x >= b.x - 50 && s.y >= b.y - 50 && s.x < b.x + b.width && s.y < b.y + b.height;
    });
    return visible ? s : { width: s.width, height: s.height };
  } catch {
    return { width: 1280, height: 860 };
  }
}
function saveState(w: BrowserWindow) {
  try {
    mkdirSync(GUI_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized() }));
  } catch {
    /* non-fatal */
  }
}

function appOrigin(): string {
  return dev ? VITE : server!.url;
}

function createWindow() {
  const st = loadState();
  const w = new BrowserWindow({
    ...st,
    minWidth: 760,
    minHeight: 480,
    title: "pi",
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    vibrancy: undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d0d10" : "#fbfbfc",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      // the page is a plain web app talking to our loopback server; it gets no Node or Electron APIs
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  win = w;
  if (st.maximized) w.maximize();
  w.once("ready-to-show", () => w.show());
  w.on("close", () => saveState(w));
  w.on("closed", () => (win = undefined));

  // Anything that isn't our own origin opens in the default browser, never inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || url.startsWith("mailto:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== appOrigin()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  const deep = process.env.PI_GUI_SNAPSHOT_HASH ? `&${process.env.PI_GUI_SNAPSHOT_HASH}` : "";
  const url = `${appOrigin()}/#token=${server!.token}${deep}`;
  const load = (attempt = 0) =>
    w.loadURL(url).catch(() => {
      // dev: Vite may still be starting
      if (dev && attempt < 40) setTimeout(() => load(attempt + 1), 250);
    });
  void load();

  // Automation (env-gated): PI_GUI_SNAPSHOT_DIR=<dir> → write <dir>/request.json {"hash":"page=agents","file":"/x.png","delay":1500}
  // and the app navigates there, captures, and deletes the request.
  const snapDir = process.env.PI_GUI_SNAPSHOT_DIR;
  if (snapDir) {
    // renderer errors land in the app log, so automated checks can see crashes
    w.webContents.on("console-message", (e) => {
      if (e.level === "error" || e.level === "warning") console.log(`[renderer ${e.level}] ${e.message}`);
    });
    const reqFile = join(snapDir, "request.json");
    let busy = false;
    setInterval(async () => {
      if (busy || !existsSync(reqFile) || w.isDestroyed()) return;
      busy = true;
      try {
        const r = JSON.parse(readFileSync(reqFile, "utf8")) as { hash?: string; file: string; delay?: number; size?: [number, number] };
        rmSync(reqFile, { force: true });
        if (r.size) w.setContentSize(r.size[0], r.size[1]);
        if (r.hash !== undefined) await w.loadURL(`${appOrigin()}/#token=${server!.token}${r.hash ? `&${r.hash}` : ""}`);
        await new Promise((res) => setTimeout(res, r.delay ?? 1500));
        writeFileSync(r.file, (await w.webContents.capturePage()).toPNG());
        console.log(`[pi-gui] snapshot ${r.file}`);
      } catch (e) {
        console.error("[pi-gui] snapshot failed", e);
      } finally {
        busy = false;
      }
    }, 200);
  }

  // Visual self-check: PI_GUI_SNAPSHOT=/path/shot.png captures the window after load.
  const snap = process.env.PI_GUI_SNAPSHOT;
  if (snap) {
    w.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        const img = await w.webContents.capturePage();
        writeFileSync(snap, img.toPNG());
        console.log(`[pi-gui] snapshot written: ${snap}`);
        if (process.env.PI_GUI_SNAPSHOT_QUIT === "1") app.quit();
      }, Number(process.env.PI_GUI_SNAPSHOT_DELAY ?? 2500)),
    );
  }
}

// IPC: native folder picker + reveal in Finder, answered only for our own page
const fromOurPage = (e: Electron.IpcMainInvokeEvent) => {
  try {
    return !!server && new URL(e.senderFrame?.url ?? "").origin === appOrigin();
  } catch {
    return false;
  }
};
ipcMain.handle("pi-gui:reveal", (e, p: unknown) => {
  if (!fromOurPage(e) || typeof p !== "string" || !p.startsWith("/") || !existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
});
ipcMain.handle("pi-gui:pick-folder", async (e) => {
  if (!fromOurPage(e)) return undefined;
  const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const r = await (w ? dialog.showOpenDialog(w, { properties: ["openDirectory", "createDirectory"], buttonLabel: "Open" }) : dialog.showOpenDialog({ properties: ["openDirectory"] }));
  return r.canceled ? undefined : r.filePaths[0];
});

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => (win ? win.focus() : createWindow()) },
        { type: "separator" },
        // ⌘W closes the open editor tab (the page decides); the window closes with ⇧⌘W
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => void win?.webContents.executeJavaScript("window.dispatchEvent(new Event('pi-gui:close-tab'))").catch(() => {}) },
        { role: "close", accelerator: "CmdOrCtrl+Shift+W" },
      ],
    },
    { role: "editMenu" }, // required on macOS for Cmd+C/V/X/A/Z to work in inputs
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "pi documentation", click: () => void shell.openExternal("https://github.com/badlogic/pi-mono") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  // Finder/Dock launches get launchd's minimal PATH; adopt the login shell's env (nvm, Homebrew, .zshrc).
  const env = await resolveShellEnv();
  if (env) applyShellEnv(env);

  // On macOS, running the main app binary as Node gives every pi process its own Dock icon ("exec").
  // The helper app is the same Electron binary but marked LSUIElement, so it stays out of the Dock.
  if (process.platform === "darwin" && app.isPackaged && !process.env.PI_GUI_NODE) {
    const name = basename(process.execPath);
    const helper = join(dirname(process.execPath), "..", "Frameworks", `${name} Helper.app`, "Contents", "MacOS", `${name} Helper`);
    if (existsSync(helper)) process.env.PI_GUI_NODE = helper;
  }

  server = await startApp({
    // prod: free port (never clashes). dev: fixed port, because Vite's proxy must know where to forward.
    port: dev ? DEV_SERVER_PORT : process.env.PI_GUI_PORT ? Number(process.env.PI_GUI_PORT) : 0,
    token: process.env.PI_GUI_TOKEN_OVERRIDE, // tests/automation only; default is a fresh random token
    staticDir: dev ? undefined : join(here, "ui"),
    bridgePath: join(here, "gui-bridge.ts"),
    extraOrigins: dev ? [VITE, VITE.replace("127.0.0.1", "localhost")] : [],
    // pi runs on Electron's bundled Node: no system Node required
    piEnv: { ELECTRON_RUN_AS_NODE: "1" },
    log: (m) => console.log(`[pi-gui] ${m}`),
  });
  console.log(`[pi-gui] server on ${server.url} · pi: ${server.piCommand.join(" ")}`);

  // The UI needs no device permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  buildMenu();
  createWindow();
}

app.on("second-instance", () => {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

// macOS convention: closing the window keeps the app (and its sessions/terminals) running.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!win && server) createWindow();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  // graceful (pi + terminals get SIGTERM, server closes) but bounded: quitting must never hang
  const deadline = new Promise((r) => setTimeout(r, 5000));
  void Promise.race([server.stop().catch(() => {}), deadline]).finally(() => {
    server?.killAll();
    app.exit(0);
  });
});
process.on("exit", () => server?.killAll()); // last line of defence against orphans
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

app.whenReady().then(boot, (e) => {
  console.error(e);
  app.exit(1);
});
