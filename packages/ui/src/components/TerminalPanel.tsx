import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Pencil, Play, Plus, RotateCw, Square, TerminalSquare, X } from "lucide-react";
import type { PortHolderInfo, TerminalInfo, TerminalProfileInfo } from "@pi-gui/protocol";
import { conn } from "../ws.ts";
import { act, confirmDialog, loadProfiles, req, useApp } from "../store.ts";
import { MOD } from "./ui.tsx";
import { isDark } from "../theme.ts";
import { droppedFiles, hasFiles, hasInternal, readInternal, shq } from "../dnd.ts";

function xtermTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const dark = isDark();
  return {
    background: v("--code-bg"),
    foreground: v("--text"),
    cursor: v("--accent"),
    cursorAccent: v("--code-bg"),
    selectionBackground: dark ? "#3f5ffe66" : "#3f5ffe33",
    black: dark ? "#2a2a33" : "#3a3a44",
    brightBlack: dark ? "#6f6f7b" : "#8b8b96",
    red: dark ? "#ff6369" : "#d6373d",
    green: dark ? "#3dd68c" : "#139162",
    yellow: dark ? "#f5b546" : "#a8690a",
    blue: dark ? "#6ea8ff" : "#2f6fd6",
    magenta: dark ? "#c69bff" : "#8e4fd6",
    cyan: dark ? "#4fd1d9" : "#13868f",
    white: dark ? "#d6d6dd" : "#55555f",
  };
}

/** Start a profile; if its port is taken, offer to kill the holder first. */
export async function startProfile(project: string, p: TerminalProfileInfo): Promise<TerminalInfo | undefined> {
  const r = await act(req<TerminalInfo | { portBusy: { port: number; holders: PortHolderInfo[] } }>("terminal.start", { project, name: p.name }));
  if (!r) return;
  if ("portBusy" in r) {
    const h = r.portBusy.holders.map((x) => `${x.pid > 0 ? `pid ${x.pid}: ` : ""}${x.command}`).join("\n");
    const ok = await confirmDialog({ title: `Port ${r.portBusy.port} is already in use`, body: `${h}\n\nStop it and start “${p.name}”?`, confirm: "Kill & start", danger: true });
    if (!ok) return;
    await act(req("terminal.killPort", { port: r.portBusy.port }));
    const again = await act(req<TerminalInfo | { portBusy: unknown }>("terminal.start", { project, name: p.name }));
    if (again && "portBusy" in again) {
      useApp.getState().toast("error", `Port ${r.portBusy.port} is still busy`);
      return;
    }
    return again as TerminalInfo;
  }
  return r;
}

export function TerminalPanel() {
  const { terminals, term, setTerm, project, profiles, setPage } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [once, setOnce] = useState("");
  const active = terminals.find((t) => t.id === term.activeId) ?? terminals[0];
  const profs = project ? profiles[project]?.profiles ?? [] : [];

  useEffect(() => {
    if (project && !profiles[project]) void loadProfiles(project);
  }, [project, profiles]);

  // one xterm per active terminal; the server replays scrollback on subscribe
  useEffect(() => {
    if (!active || !host.current) return;
    const x = new XTerm({
      fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      theme: xtermTheme(),
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    x.loadAddon(fit);
    x.open(host.current);
    const id = active.id;
    const doFit = () => {
      try {
        fit.fit();
        conn.send({ t: "pty_resize", id, cols: x.cols, rows: x.rows });
      } catch {
        /* hidden */
      }
    };
    requestAnimationFrame(doFit);
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host.current);
    const unsub = conn.sub(`terminal:${id}`, (e) => {
      if (e.kind === "pty_out") x.write(e.data);
    });
    const dataSub = x.onData((d) => conn.send({ t: "pty_in", id, data: d }));
    // ⌘K etc. stay app shortcuts; ⌘C copies a selection
    x.attachCustomKeyEventHandler((ev) => !(ev.metaKey && ["k", "j", "n"].includes(ev.key.toLowerCase())));
    x.focus();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onTheme = () => (x.options.theme = xtermTheme());
    mq?.addEventListener("change", onTheme);
    return () => {
      mq?.removeEventListener("change", onTheme);
      ro.disconnect();
      unsub();
      dataSub.dispose();
      x.dispose();
    };
  }, [active?.id]);

  function onDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = term.height;
    setDragging(true);
    const move = (ev: MouseEvent) => setTerm({ height: Math.max(140, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY))) });
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  async function runOnce(command: string) {
    if (!project) return useApp.getState().toast("warning", "Open a project first");
    const t = await act(req<TerminalInfo>("terminal.runOnce", { project, command }));
    if (t) {
      setTerm({ activeId: t.id });
      setOnce("");
    }
  }

  return (
    <div className="term-panel" style={{ height: term.height }}>
      <div className={`term-resize ${dragging ? "dragging" : ""}`} onMouseDown={onDrag} />
      <div className="term-tabs">
        {terminals.length === 0 && <span className="faint small" style={{ padding: "0 8px" }}>No terminals running</span>}
        {terminals.map((t) => (
          <button key={t.id} className={`term-tab ${t.id === active?.id ? "active" : ""}`} onClick={() => setTerm({ activeId: t.id })} title={`${t.command}\n${t.cwd}`}>
            <span className={`dot ${t.status}`} />
            {t.name}
            <span
              className="icon-btn"
              role="button"
              title={t.status === "running" ? "Stop & close" : "Close"}
              onClick={(e) => {
                e.stopPropagation();
                void act(req("terminal.close", { id: t.id }));
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
        <div className="term-toolbar">
          {active && (
            <>
              {active.status === "running" ? (
                <button className="icon-btn" title="Stop (SIGTERM to the whole process group)" onClick={() => void act(req("terminal.stop", { id: active.id }))}>
                  <Square size={13} />
                </button>
              ) : null}
              <button className="icon-btn" title="Restart" onClick={() => void act(req("terminal.restart", { id: active.id }))}>
                <RotateCw size={14} />
              </button>
            </>
          )}
          <button className="icon-btn" title="New shell" onClick={() => void runOnce("")}>
            <Plus size={15} />
          </button>
          <button className="icon-btn" title={`Hide panel (${MOD}J)`} onClick={() => setTerm({ open: false })}>
            <ChevronDown size={15} />
          </button>
        </div>
      </div>
      <div className="term-body">
        <div
          className="term-host"
          ref={host}
          onDragOver={(e) => {
            if (!active || (!hasInternal(e.dataTransfer) && !hasFiles(e.dataTransfer))) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            if (!active) return;
            const dt = e.dataTransfer;
            const internal = hasInternal(dt) ? readInternal(dt) : undefined;
            const paths = internal ? internal.paths.map((p) => `${internal.root}/${p}`) : hasFiles(dt) ? droppedFiles(dt).paths : [];
            if (!paths.length) return;
            e.preventDefault();
            // like Terminal.app: paste the shell-quoted path(s), don't press enter
            conn.send({ t: "pty_in", id: active.id, data: paths.map(shq).join(" ") + " " });
          }}
        >
          {!active && (
            <div className="empty-state" style={{ height: "100%" }}>
              <TerminalSquare size={22} className="faint" />
              <p className="small">Start a profile on the right, or run a one-off command.</p>
            </div>
          )}
        </div>
        <div className="term-side">
          <div className="term-side-title row">
            Profiles
            <button className="icon-btn" style={{ marginLeft: "auto", width: 22, height: 22 }} title="Edit profiles" onClick={() => setPage("terminals")}>
              <Pencil size={12} />
            </button>
          </div>
          {profs.length === 0 && <div className="faint small" style={{ padding: "0 4px" }}>No saved terminals for this project.</div>}
          {profs.map((p) => {
            const live = terminals.find((t) => t.id === p.id);
            const running = live?.status === "running";
            return (
              <div className="prof" key={p.id} title={p.cwdError ?? `${p.command}\n${p.resolvedCwd}`}>
                <span className={`dot ${live?.status ?? "stopped"}`} />
                <div className="grow">
                  <div className="ellipsis">{p.name}</div>
                  <div className="sub">{p.cwdError ? <span className="err-text">folder missing</span> : p.command}</div>
                </div>
                {running ? (
                  <button className="icon-btn" title="Stop" onClick={() => void act(req("terminal.stop", { id: p.id }))}>
                    <Square size={12} />
                  </button>
                ) : (
                  <button
                    className="icon-btn"
                    title="Start"
                    disabled={!!p.cwdError}
                    onClick={async () => {
                      const t = await startProfile(project!, p);
                      if (t) setTerm({ activeId: t.id });
                    }}
                  >
                    <Play size={13} />
                  </button>
                )}
              </div>
            );
          })}
          <div className="term-side-title" style={{ marginTop: 8 }}>
            Run once
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (once.trim()) void runOnce(once);
            }}
          >
            <input className="input mono" placeholder="e.g. pod install" value={once} onChange={(e) => setOnce(e.target.value)} />
          </form>
        </div>
      </div>
    </div>
  );
}
