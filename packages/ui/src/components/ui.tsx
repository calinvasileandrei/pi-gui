import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useApp } from "../store.ts";

export function Modal(props: { onClose?: () => void; wide?: boolean; children: ReactNode; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.onClose) {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [props.onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className={`modal ${props.wide ? "wide" : ""} ${props.className ?? ""}`} role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="icon-wrap">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Promise-based confirm host (see confirmDialog in store). */
export function ConfirmHost() {
  const c = useApp((s) => s.confirmReq);
  if (!c) return null;
  const done = (ok: boolean) => {
    useApp.setState({ confirmReq: undefined });
    c.resolve(ok);
  };
  return (
    <Modal onClose={() => done(false)}>
      <div className="modal-head">
        <div className={`modal-icon ${c.danger ? "err" : ""}`}>{c.danger ? <AlertTriangle size={17} /> : <Info size={17} />}</div>
        <div>
          <h3>{c.title}</h3>
          {c.body && <p>{c.body}</p>}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => done(false)}>
          Cancel
        </button>
        <button className={`btn ${c.danger ? "danger solid" : "primary"}`} autoFocus onClick={() => done(true)}>
          {c.confirm ?? "Confirm"}
        </button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const icon = { error: <XCircle size={16} />, warning: <AlertTriangle size={16} />, success: <CheckCircle2 size={16} />, info: <Info size={16} /> };
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => useApp.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
          {icon[t.level]}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function timeAgo(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const shortPath = (p: string, home?: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function PromptHost() {
  const p = useApp((s) => s.promptReq);
  const [v, setV] = useState("");
  useEffect(() => setV(p?.value ?? ""), [p]);
  if (!p) return null;
  const done = (val: string | undefined) => {
    useApp.setState({ promptReq: undefined });
    p.resolve(val);
  };
  return (
    <Modal onClose={() => done(undefined)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) done(v.trim());
        }}
      >
        <div className="modal-head">
          <div>
            <h3>{p.title}</h3>
            {p.body && <p>{p.body}</p>}
          </div>
        </div>
        <div className="modal-body">
          <input className="input" autoFocus value={v} placeholder={p.placeholder} list="prompt-suggest" onChange={(e) => setV(e.target.value)} />
          <datalist id="prompt-suggest">{p.suggestions?.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => done(undefined)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>
            {p.confirm ?? "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
