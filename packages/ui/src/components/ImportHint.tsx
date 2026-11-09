import { Download, X } from "lucide-react";
import { useState } from "react";

/** "Found 3 servers in Claude Code and Cursor" — one click to review and import. Dismissal is remembered per kind + set. */
export function ImportHint({ kind, items, from, onReview }: { kind: string; items: string[]; from: string[]; onReview: () => void }) {
  const key = `pi-gui-import-hint:${kind}:${[...items].sort().join(",")}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  if (!items.length || hidden) return null;
  const n = items.length;
  const apps = from.length <= 2 ? from.join(" and ") : `${from.slice(0, -1).join(", ")} and ${from[from.length - 1]}`;
  return (
    <div className="import-hint">
      <Download size={15} />
      <span className="grow">
        Found <b>{n} {kind}{n === 1 ? "" : "s"}</b> in {apps} you haven't brought over yet.
      </span>
      <button className="btn sm primary" onClick={onReview}>
        Review &amp; import
      </button>
      <button
        className="icon-btn"
        title="Dismiss"
        onClick={() => {
          try {
            localStorage.setItem(key, "1");
          } catch {
            /* private mode */
          }
          setHidden(true);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}
