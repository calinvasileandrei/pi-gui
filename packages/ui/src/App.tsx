import { useEffect } from "react";
import { FolderPlus, Sparkles } from "lucide-react";
import { emptyChat } from "./chat-state.ts";
import { attachSession, closeViewer, openSession, openViewer, pickFolder, req, switchProject, useApp } from "./store.ts";
import { useProject, useProjectSync } from "./project.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { Composer } from "./components/Composer.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { GitPanel } from "./components/GitPanel.tsx";
import { EditorTabs, EditorView } from "./components/EditorView.tsx";
import { LeftToggles, Resizer, RightToggle } from "./components/Layout.tsx";
import { RunsView } from "./components/RunsView.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { Dialogs } from "./components/Dialogs.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ConfirmHost, Empty, Kbd, MOD, PromptHost, Toasts, baseName, shortPath } from "./components/ui.tsx";
import { AgentsPage } from "./pages/AgentsPage.tsx";
import { ExtensionsPage } from "./pages/ExtensionsPage.tsx";
import { McpPage } from "./pages/McpPage.tsx";
import { useMcpSync } from "./mcp.ts";
import { TerminalsPage } from "./pages/TerminalsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useApp.getState();
      const k = e.key.toLowerCase();
      if (e.code === "KeyB" && e.altKey) st.setPanels({ git: !st.panels.git });
      else if (e.code === "KeyB") st.setPanels({ explorer: !st.panels.explorer });
      else if (e.code === "Backslash") st.setPanels({ sessions: !st.panels.sessions });
      else if (k === "w" && !e.shiftKey && !(window as { piGui?: unknown }).piGui) closeCurrentTab();
      else if (k === "k") useApp.setState({ palette: !st.palette });
      else if (k === "j") st.setTerm({ open: !st.term.open });
      else if (k === "n" && !e.shiftKey) void (st.project ? openSession(st.project) : pickFolder().then((d) => (d ? openSession(d) : undefined)));
      else if (k === "o") void pickFolder().then((d) => (d ? switchProject(d) : undefined));
      else if (k === ",") st.setPage("settings");
      else if (["1", "2"].includes(k) && st.activeId) {
        st.setPage("session");
        st.setTab((["chat", "runs"] as const)[Number(k) - 1]!);
      } else return;
      e.preventDefault();
    };
    // Mac app: ⌘W comes from the menu
    const onClose = () => closeCurrentTab();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pi-gui:close-tab", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pi-gui:close-tab", onClose);
    };
  }, []);
}

function closeCurrentTab() {
  const st = useApp.getState();
  if (st.tab === "view" && st.viewKey) void closeViewer(st.viewKey);
}

// Dropping files anywhere that isn't a drop target must never navigate the window away.
function useDropGuard() {
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (!e.defaultPrevented) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      }
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
}

function Welcome() {
  const project = useApp((s) => s.project);
  const home = useApp((s) => s.home);
  if (project)
    return (
      <Empty icon={<Sparkles size={22} />} title={baseName(project)}>
        <p className="mono small">{shortPath(project, home)}</p>
        <p>No session open in this folder. Start one, or pick a file in the explorer.</p>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn primary lg" onClick={() => void openSession(project)}>
            <Sparkles size={15} /> New session here
          </button>
          <button className="btn lg" onClick={() => void pickFolder().then((d) => d && switchProject(d))}>
            <FolderPlus size={15} /> Other folder…
          </button>
        </div>
        <p className="faint small" style={{ marginTop: 6 }}>
          <Kbd>{MOD}N</Kbd> new session · <Kbd>{MOD}B</Kbd> files · <Kbd>{MOD}⌥B</Kbd> source control · <Kbd>{MOD}J</Kbd> terminal
        </p>
      </Empty>
    );
  return (
    <Empty icon={<Sparkles size={22} />} title="Welcome to pi">
      <p>Open a project folder to start a session. Sessions you started in pi in the terminal show up in the sidebar too.</p>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn primary lg" onClick={() => void pickFolder().then((d) => (d ? switchProject(d) : undefined))}>
          <FolderPlus size={15} /> Open folder
        </button>
      </div>
      <p className="faint small" style={{ marginTop: 6 }}>
        <Kbd>{MOD}K</Kbd> command palette · <Kbd>{MOD}J</Kbd> terminal · <Kbd>{MOD}N</Kbd> new session
      </p>
    </Empty>
  );
}

function BareBar() {
  const project = useApp((s) => s.project);
  return (
    <div className="topbar drag">
      <LeftToggles />
      <div className="topbar-title">{project && <h1 className="faint-title">{baseName(project)}</h1>}</div>
      <div className="topbar-right">
        <RightToggle />
      </div>
    </div>
  );
}

export function App() {
  const { conn, activeId, chats, sessions, error, page, tab, term, palette, panels, project, viewers, viewKey } = useApp();
  const chat = activeId ? (chats[activeId] ?? emptyChat()) : undefined;
  const active = sessions.find((s) => s.id === activeId);
  const viewer = tab === "view" ? viewers.find((v) => v.key === viewKey) : undefined;
  useShortcuts();
  useDropGuard();
  useProjectSync(project, chat?.changesVersion ?? 0);
  useMcpSync(project);

  useEffect(() => {
    if (activeId && active) void attachSession(activeId);
  }, [activeId, !!active]);
  useEffect(() => {
    document.title = active?.name ? `${active.name} — pi` : project ? `${baseName(project)} — pi` : "pi";
  }, [active?.name, project]);
  // a tab pointing at a closed viewer falls back to the chat
  useEffect(() => {
    if (tab === "view" && !viewer) useApp.setState({ tab: "chat" });
  }, [tab, viewer]);

  if (conn === "no-token")
    return (
      <div className="fatal">
        <div>
          <h3>Missing access token</h3>
          <p>Open the URL printed by the server — it ends with #token=…</p>
        </div>
      </div>
    );

  // tool card "Open full diff": the path may be absolute or relative to the session folder
  const openDiff = (path: string) => {
    const cwd = active?.cwd ?? project;
    if (!cwd) return;
    const info = useProject.getState().git[cwd];
    const root = info?.root ?? cwd;
    const abs = path.startsWith("/") ? path : `${cwd}/${path.replace(/^@/, "")}`;
    const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : path;
    openViewer({ kind: "diff", root, cwd, path: rel, base: info?.git === false ? "agent" : "head" });
  };

  const lead = !panels.sessions ? (panels.explorer ? "lead-explorer" : "lead-main") : "";
  const sessionPage = page === "session";

  return (
    <div className={`app ${lead}`}>
      {panels.sessions && <Sidebar />}
      {panels.explorer && (
        <aside className="side-col explorer-col" style={{ width: panels.explorerW }}>
          <FileTree />
          <Resizer panel="explorerW" side="right" />
        </aside>
      )}
      <main className="main">
        {sessionPage && active && chat ? <TopBar id={active.id} chat={chat} /> : <BareBar />}
        {sessionPage && <EditorTabs />}
        {sessionPage && active && chat && !viewer && (
          <>
            {conn !== "open" && <div className="banner warn">Disconnected from the pi-gui server — reconnecting…</div>}
            {error && <div className="banner warn">{error}</div>}
            {chat.info?.status === "crashed" && (
              <div className="banner err" style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  <strong>pi stopped unexpectedly</strong> (exit {String(chat.info.exitInfo?.code ?? chat.info.exitInfo?.signal)}). The conversation is safe on disk.
                  {chat.info.exitInfo?.stderrTail && <pre>{chat.info.exitInfo.stderrTail.slice(-1500)}</pre>}
                </div>
                <button className="btn primary sm" onClick={() => void req("session.restart", { id: active.id })}>
                  Restart
                </button>
              </div>
            )}
            {chat.retry && (
              <div className="banner warn">
                <span className="spinner" /> Retrying ({chat.retry.attempt}/{chat.retry.maxAttempts}) — {/429|rate/i.test(chat.retry.errorMessage) ? "rate-limited by the provider" : chat.retry.errorMessage.slice(0, 160)}
              </div>
            )}
            {chat.compacting && (
              <div className="banner info">
                <span className="spinner" /> Compacting context…
              </div>
            )}
          </>
        )}
        {sessionPage ? (
          <div className="content">
            {viewer ? (
              <EditorView v={viewer} />
            ) : active && chat ? (
              <>
                {tab !== "runs" && (
                  <>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <ChatView chat={chat} sessionId={active.id} onOpenDiff={openDiff} />
                    </div>
                    <Composer id={active.id} chat={chat} />
                  </>
                )}
                {tab === "runs" && <RunsView id={active.id} chat={chat} />}
              </>
            ) : (
              <Welcome />
            )}
          </div>
        ) : (
          <>
            {page === "agents" && <AgentsPage />}
            {page === "mcp" && <McpPage />}
            {page === "extensions" && <ExtensionsPage />}
            {page === "terminals" && <TerminalsPage />}
            {page === "settings" && <SettingsPage />}
          </>
        )}
        {term.open && <TerminalPanel />}
      </main>
      {panels.git && (
        <aside className="side-col git-col" style={{ width: panels.gitW }}>
          <Resizer panel="gitW" side="left" />
          <GitPanel />
        </aside>
      )}
      <Dialogs />
      {palette && <CommandPalette />}
      <ConfirmHost />
      <PromptHost />
      <Toasts />
    </div>
  );
}
