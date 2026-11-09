import { create } from "zustand";
import type { ConfigError, GuiSettings, SessionInfo, StoredSession, TerminalInfo, TerminalProfileInfo } from "@pi-gui/protocol";
import { applySnapshot, emptyChat, reduceChat, type ChatState } from "./chat-state.ts";
import { conn, type ConnStatus } from "./ws.ts";

export type Page = "session" | "agents" | "mcp" | "extensions" | "terminals" | "settings";
export type Tab = "chat" | "runs" | "view";

/** a file or diff opened in the main area (editor tabs) */
export interface Viewer {
  key: string;
  kind: "file" | "diff";
  /** project folder (file) or git root (diff) the path is relative to */
  root: string;
  /** project folder — git ops need it for diffs */
  cwd: string;
  path: string;
  base?: "head" | "agent";
}

export interface Panels {
  sessions: boolean;
  explorer: boolean;
  git: boolean;
  explorerW: number;
  gitW: number;
}

export interface Toast {
  id: number;
  level: "info" | "warning" | "error" | "success";
  text: string;
}
interface ConfirmReq {
  title: string;
  body?: string;
  confirm?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface PromptReq {
  title: string;
  body?: string;
  value?: string;
  placeholder?: string;
  confirm?: string;
  suggestions?: string[];
  resolve: (v: string | undefined) => void;
}

interface AppStore {
  promptReq?: PromptReq;
  panels: Panels;
  setPanels(p: Partial<Panels>): void;
  /** open editor tabs + the one showing when tab === "view" */
  viewers: Viewer[];
  viewKey?: string;
  /** unsaved edits per viewer key */
  dirty: Record<string, boolean>;
  conn: ConnStatus;
  sessions: SessionInfo[];
  activeId?: string;
  page: Page;
  tab: Tab;
  chats: Record<string, ChatState>;
  settings?: GuiSettings;
  home?: string;
  pty: boolean;
  bridge: boolean;
  error?: string;
  /** project folder in focus (active session's cwd, or picked in the sidebar) */
  project?: string;
  stored: StoredSession[];
  terminals: TerminalInfo[];
  profiles: Record<string, { profiles: TerminalProfileInfo[]; errors: ConfigError[] }>;
  term: { open: boolean; height: number; activeId?: string };
  toasts: Toast[];
  confirmReq?: ConfirmReq;
  palette: boolean;
  setActive(id?: string): void;
  setPage(p: Page): void;
  setTab(t: Tab): void;
  setProject(p?: string): void;
  updateChat(id: string, f: (c: ChatState) => ChatState): void;
  toast(level: Toast["level"], text: string): void;
  setTerm(t: Partial<AppStore["term"]>): void;
}

const ls = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

let toastId = 0;
export const useApp = create<AppStore>((set, get) => ({
  conn: "connecting",
  sessions: [],
  page: "session",
  tab: "chat",
  chats: {},
  pty: true,
  bridge: true,
  stored: [],
  terminals: [],
  profiles: {},
  term: ls.get("pi-gui-term", { open: false, height: 280 }),
  panels: { sessions: true, explorer: true, git: true, explorerW: 260, gitW: 320, ...ls.get<Partial<Panels>>("pi-gui-panels", {}) },
  setPanels: (p) => {
    const panels = { ...get().panels, ...p };
    set({ panels });
    ls.set("pi-gui-panels", panels);
  },
  viewers: [],
  dirty: {},
  toasts: [],
  palette: false,
  project: ls.get<string | undefined>("pi-gui-project", undefined),
  setActive: (id) => {
    const s = get().sessions.find((x) => x.id === id);
    set({ activeId: id, page: "session", ...(s ? { project: s.cwd } : {}) });
    ls.set("pi-gui-active", id ?? null);
    if (s) ls.set("pi-gui-project", s.cwd);
  },
  setPage: (page) => set({ page }),
  setTab: (tab) => set({ tab }),
  setProject: (project) => {
    set({ project });
    ls.set("pi-gui-project", project ?? null);
    if (project) rememberProject(project);
  },
  updateChat: (id, f) => set((s) => ({ chats: { ...s.chats, [id]: f(s.chats[id] ?? emptyChat()) } })),
  toast: (level, text) => {
    const t = { id: ++toastId, level, text };
    set((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), level === "error" ? 9000 : 4500);
  },
  setTerm: (t) => {
    const term = { ...get().term, ...t };
    set({ term });
    ls.set("pi-gui-term", { open: term.open, height: term.height });
  },
}));

export const req = conn.req.bind(conn);

/** Promise-based confirm dialog (never window.confirm: it blocks the renderer). */
export function confirmDialog(o: Omit<ConfirmReq, "resolve">): Promise<boolean> {
  return new Promise((resolve) => useApp.setState({ confirmReq: { ...o, resolve } }));
}

/** Promise-based single-line input dialog. */
export function promptDialog(o: Omit<PromptReq, "resolve">): Promise<string | undefined> {
  return new Promise((resolve) => useApp.setState({ promptReq: { ...o, resolve } }));
}

/** Native folder picker in the Mac app (preload bridge), text prompt in the browser. */
export async function pickFolder(): Promise<string | undefined> {
  const native = (window as { piGui?: { pickFolder?: () => Promise<string | undefined> } }).piGui?.pickFolder;
  if (native) return native();
  return promptDialog({ title: "Open project folder", placeholder: "/path/to/project or ~/project", confirm: "Open", suggestions: recentProjects() });
}

/** Run an op and toast its error instead of throwing. */
export async function act<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (ok) useApp.getState().toast("success", ok);
    return r;
  } catch (e) {
    useApp.getState().toast("error", (e as Error).message);
    return undefined;
  }
}

// ---- projects (recent folders) ----
export function recentProjects(): string[] {
  return ls.get<string[]>("pi-gui-projects", []);
}
export function rememberProject(dir: string) {
  ls.set("pi-gui-projects", [dir, ...recentProjects().filter((d) => d !== dir)].slice(0, 12));
}
/** sidebar order of projects (repo keys), set by dragging; new projects go on top */
export function projectOrder(): string[] {
  return ls.get<string[]>("pi-gui-project-order", []);
}
export function setProjectOrder(keys: string[]) {
  ls.set("pi-gui-project-order", [...new Set(keys)]);
}
export function forgetProject(dir: string) {
  ls.set("pi-gui-projects", recentProjects().filter((d) => d !== dir));
}

// ---- sessions ----
const chatSubs = new Map<string, () => void>();

/** Ensure we hold a live, snapshotted view of a session. Idempotent. */
export async function attachSession(id: string): Promise<void> {
  if (chatSubs.has(id)) return;
  const { updateChat } = useApp.getState();
  chatSubs.set(id, () => {});
  const load = async () => {
    const [snap, runs, notes, approvals, questions] = await Promise.all([
      conn.req("session.snapshot", { id }),
      conn.req("runs.list", { id }).catch(() => []),
      conn.req("runs.notes", { id }).catch(() => []),
      conn.req("approvals.get", { id }).catch(() => ({ pending: [] })),
      conn.req("runs.questions", { id }).catch(() => []),
    ]);
    updateChat(id, (c) => ({ ...applySnapshot(c, snap), runs, notes, approvals: approvals.pending, questions }));
    return snap.seq as number;
  };
  try {
    const seq = await load();
    const unsub = conn.sub(`session:${id}`, (e) => {
      if (e.kind === "rpc" && e.record.type === "extension_ui_request") {
        const r = e.record;
        if (r.method === "set_editor_text") window.dispatchEvent(new CustomEvent("pi-gui:editor-text", { detail: { id, text: r.text ?? "" } }));
        if (r.method === "setTitle" && r.title && useApp.getState().activeId === id) document.title = `${r.title} — pi`;
      }
      updateChat(id, (c) => reduceChat(c, e));
    }, {
      since: seq,
      onReset: () => void load().catch(() => {}),
    });
    chatSubs.set(id, unsub);
  } catch (e) {
    chatSubs.delete(id);
    useApp.getState().toast("error", (e as Error).message);
  }
}

export function detachSession(id: string) {
  chatSubs.get(id)?.();
  chatSubs.delete(id);
  useApp.setState((s) => {
    const chats = { ...s.chats };
    delete chats[id];
    return { chats };
  });
}

export async function refreshStored() {
  const stored = await conn.req<StoredSession[]>("stored.list", {}).catch(() => []);
  useApp.setState({ stored });
}

export async function loadProfiles(project: string) {
  const r = await conn.req("terminal.profiles", { project }).catch((e) => ({ profiles: [], errors: [{ file: project, message: e.message }] }));
  useApp.setState((s) => ({ profiles: { ...s.profiles, [project]: r } }));
  return r;
}

/** Open (or focus) a session for a project folder, optionally resuming a pi session file. */
export async function openSession(cwd: string, sessionFile?: string, name?: string) {
  const info = await act(req<SessionInfo>("session.create", { cwd, sessionFile, name }));
  if (info) {
    useApp.getState().setProject(info.cwd);
    useApp.getState().setActive(info.id);
    void refreshStored();
  }
  return info;
}

export function boot() {
  conn.onStatus((c) => {
    useApp.setState({ conn: c });
    if (c !== "open") return;
    conn
      .req("app.hello")
      .then((h) => {
        useApp.setState({ sessions: h.sessions, terminals: h.terminals ?? [], settings: h.settings, home: h.cwd, pty: h.pty, bridge: h.bridge, error: h.settingsError });
        const st = useApp.getState();
        const remembered = ls.get<string | null>("pi-gui-active", null);
        const pick = (st.activeId && h.sessions.some((s: SessionInfo) => s.id === st.activeId) ? st.activeId : undefined) ?? h.sessions.find((s: SessionInfo) => s.id === remembered && !s.parentId)?.id;
        if (pick) st.setActive(pick);
        for (const id of [...chatSubs.keys()]) if (!h.sessions.some((s: SessionInfo) => s.id === id)) detachSession(id);
        void refreshStored();
        if (st.project) void loadProfiles(st.project);
      })
      .catch((e) => useApp.setState({ error: e.message }));
  });
  conn.sub("app", (e) => {
    const st = useApp.getState();
    switch (e.kind) {
      case "sessions":
        useApp.setState({ sessions: e.sessions });
        if (st.activeId && !e.sessions.some((s) => s.id === st.activeId)) useApp.setState({ activeId: undefined });
        break;
      case "terminals":
        useApp.setState({ terminals: e.terminals });
        break;
      case "profiles":
        useApp.setState((s) => ({ profiles: { ...s.profiles, [e.project]: { profiles: e.profiles, errors: e.errors } } }));
        break;
      case "toast":
        st.toast(e.level, e.message);
        break;
      case "stored_changed":
        void refreshStored();
        break;
      case "approval_done":
        for (const id of Object.keys(st.chats)) st.updateChat(id, (c) => ({ ...c, approvals: c.approvals.filter((a) => a.id !== e.id) }));
        break;
    }
  });
  conn.connect();
}

// ---- native bridge (Mac app preload; absent in a browser) ----
interface NativeBridge {
  pickFolder?: () => Promise<string | undefined>;
  reveal?: (p: string) => Promise<boolean>;
  pathForFile?: (f: File) => string;
}
export const native = (): NativeBridge => (window as { piGui?: NativeBridge }).piGui ?? {};

// ---- projects: switching the focused folder moves every panel with it ----
/** Focus a project folder: explorer + git panel follow; its newest open session (if any) becomes active. */
export function switchProject(dir: string) {
  const st = useApp.getState();
  st.setProject(dir);
  const live = st.sessions.filter((s) => !s.parentId && s.cwd === dir);
  const cur = live.find((s) => s.id === st.activeId) ?? live[live.length - 1];
  useApp.setState({ activeId: cur?.id, page: "session", tab: st.tab === "view" ? "view" : "chat" });
  ls.set("pi-gui-active", cur?.id ?? null);
}

// ---- editor tabs ----
export function openViewer(v: Omit<Viewer, "key">) {
  const key = `${v.kind}:${v.root}:${v.path}`;
  useApp.setState((s) => ({
    viewers: s.viewers.some((x) => x.key === key) ? s.viewers.map((x) => (x.key === key ? { ...x, ...v, key } : x)) : [...s.viewers, { ...v, key }],
    viewKey: key,
    tab: "view",
    page: "session",
  }));
}
export async function closeViewer(key: string) {
  const s = useApp.getState();
  if (s.dirty[key] && !(await confirmDialog({ title: "Discard unsaved changes?", body: "This file has edits that aren't saved.", confirm: "Discard", danger: true }))) return;
  useApp.setState((st) => {
    const i = st.viewers.findIndex((x) => x.key === key);
    const viewers = st.viewers.filter((x) => x.key !== key);
    const dirty = { ...st.dirty };
    delete dirty[key];
    if (st.viewKey !== key) return { viewers, dirty };
    const next = viewers[Math.min(i, viewers.length - 1)];
    return { viewers, dirty, viewKey: next?.key, tab: next ? "view" : "chat" };
  });
}

/** unsent composer text per session (survives switching tabs/sessions) */
export const drafts = new Map<string, string>();
/** session id whose composer is mounted right now */
export const composerState: { mounted?: string } = {};

/** Put text into the active session's composer (drag a file in, "Add to chat"). */
export function insertIntoComposer(text: string) {
  const st = useApp.getState();
  if (!st.activeId) return st.toast("info", "Open a session first");
  const id = st.activeId;
  if (composerState.mounted === id && st.tab === "chat" && st.page === "session") {
    window.dispatchEvent(new CustomEvent("pi-gui:insert", { detail: { id, text } }));
    return;
  }
  const cur = drafts.get(id) ?? "";
  drafts.set(id, cur && !/\s$/.test(cur) ? `${cur} ${text}` : cur + text);
  useApp.setState({ page: "session", tab: "chat" });
}

/** a file/folder was moved or renamed on disk: keep its open tabs pointing at it */
export function renameViewerPaths(root: string, from: string, to: string) {
  const map = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  useApp.setState((s) => {
    const rekey: Record<string, string> = {};
    const viewers = s.viewers.map((v) => {
      if (v.root !== root || map(v.path) === v.path) return v;
      const path = map(v.path);
      const key = `${v.kind}:${v.root}:${path}`;
      rekey[v.key] = key;
      return { ...v, path, key };
    });
    if (!Object.keys(rekey).length) return {};
    const dirty: Record<string, boolean> = {};
    for (const [k, d] of Object.entries(s.dirty)) dirty[rekey[k] ?? k] = d;
    return { viewers, dirty, viewKey: s.viewKey && rekey[s.viewKey] ? rekey[s.viewKey] : s.viewKey };
  });
}
