import { useEffect, useState } from "react";
import type { GuiSettings } from "@pi-gui/protocol";
import { act, req, useApp } from "../store.ts";
import { Field, Toggle } from "../components/ui.tsx";
import { applyTheme, getTheme, type Theme } from "../theme.ts";

export function SettingsPage() {
  const { settings, pty, bridge } = useApp();
  const [s, setS] = useState<GuiSettings | undefined>(settings);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [piCmd, setPiCmd] = useState<string>("");
  const [claudeBin, setClaudeBin] = useState<string>();
  useEffect(() => {
    void req<{ harnesses: { id: string; bin?: string }[] }>("harness.list").then((h) => setClaudeBin(h.harnesses.find((x) => x.id === "claude")?.bin ?? ""), () => {});
  }, [settings?.claudeBin]);
  useEffect(() => setS(settings), [settings]);
  useEffect(() => {
    void req<{ piCommand: string[] }>("app.hello").then((h) => setPiCmd(h.piCommand.join(" ")), () => {});
  }, []);
  if (!s) return null;

  async function save(patch: Partial<GuiSettings>) {
    const next = await act(req<GuiSettings>("settings.save", patch));
    if (next) {
      setS(next);
      useApp.setState({ settings: next });
    }
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <div className="page-head">
          <div>
            <h2>Settings</h2>
            <p>Stored in ~/.pi-gui/settings.json. Providers, models and logins are pi's own (run <code>pi</code> → <code>/login</code>).</p>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Appearance</h3>
          </div>
          <div className="card-body">
            <div className="seg">
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  className={theme === t ? "on" : ""}
                  onClick={() => {
                    setTheme(t);
                    applyTheme(t);
                  }}
                >
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Agent</h3>
          </div>
          <div className="card-body form">
            <Field label="New sessions run on" hint="Claude Code uses your own `claude` login, so turns count against your Claude plan instead of an API key. Pick a Claude model in any session's model menu to switch.">
              <div className="seg">
                <button className={s.defaultHarness === "pi" ? "on" : ""} onClick={() => void save({ defaultHarness: "pi" })}>
                  pi
                </button>
                <button className={s.defaultHarness === "claude" ? "on" : ""} disabled={claudeBin === ""} onClick={() => void save({ defaultHarness: "claude" })}>
                  Claude Code
                </button>
              </div>
            </Field>
            <Field label="Claude Code command" hint={claudeBin ? `Using ${claudeBin}` : claudeBin === "" ? "Not found — install Claude Code and log in once in a terminal, or enter its path." : " "}>
              <input
                className="input mono"
                placeholder="claude (found on PATH)"
                value={s.claudeBin ?? ""}
                onChange={(e) => setS({ ...s, claudeBin: e.target.value || undefined })}
                onBlur={() => void save({ claudeBin: s.claudeBin || undefined })}
              />
            </Field>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Subagents</h3>
          </div>
          <div className="card-body form">
            <div className="grid-2">
              <Field label="Parallel subagents" hint="Keeps you under provider rate limits.">
                <input className="input" type="number" min={1} max={10} value={s.subagentConcurrency} onChange={(e) => setS({ ...s, subagentConcurrency: Number(e.target.value) })} onBlur={() => void save({ subagentConcurrency: s.subagentConcurrency })} />
              </Field>
              <Field label="Max depth" hint="1 = subagents can't spawn subagents (unless the agent has canSpawn).">
                <input className="input" type="number" min={0} max={3} value={s.subagentMaxDepth} onChange={(e) => setS({ ...s, subagentMaxDepth: Number(e.target.value) })} onBlur={() => void save({ subagentMaxDepth: s.subagentMaxDepth })} />
              </Field>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Sessions</h3>
          </div>
          <div className="list-item">
            <div className="grow">
              <div className="title">Restart pi automatically after a crash</div>
              <div className="sub">Up to 3 times a minute, resuming the same session file.</div>
            </div>
            <Toggle on={s.restartOnCrash} onChange={(v) => void save({ restartOnCrash: v })} label="Restart on crash" />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Diagnostics</h3>
          </div>
          <div className="list-item">
            <div className="grow">
              <div className="title">pi</div>
              <div className="path">{piCmd}</div>
            </div>
          </div>
          <div className="list-item">
            <div className="grow">
              <div className="title">gui-bridge extension</div>
              <div className="sub">Subagents, blackboard, terminal_read, edit snapshots and approvals.</div>
            </div>
            <span className={`badge ${bridge ? "ok" : "err"}`}>{bridge ? "loaded" : "missing"}</span>
          </div>
          <div className="list-item">
            <div className="grow">
              <div className="title">Real terminals (node-pty)</div>
              <div className="sub">Needed for Metro's interactive keys and colours.</div>
            </div>
            <span className={`badge ${pty ? "ok" : "warn"}`}>{pty ? "available" : "fallback (no TTY)"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
