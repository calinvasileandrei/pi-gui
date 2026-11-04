import { useRef, useState } from "react";
import { GitBranch, PanelLeft, FolderTree } from "lucide-react";
import { useApp, type Panels } from "../store.ts";
import { useProject } from "../project.ts";
import { MOD } from "./ui.tsx";

/** Drag handle on a panel edge; `side` is where the handle sits on the panel. */
export function Resizer({ panel, side, min = 180, max = 640 }: { panel: "explorerW" | "gitW"; side: "left" | "right"; min?: number; max?: number }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  return (
    <div
      className={`col-resize ${side} ${dragging ? "dragging" : ""}`}
      onDoubleClick={() => useApp.getState().setPanels({ [panel]: panel === "explorerW" ? 260 : 320 } as Partial<Panels>)}
      onMouseDown={(e) => {
        e.preventDefault();
        start.current = { x: e.clientX, w: useApp.getState().panels[panel] };
        setDragging(true);
        document.body.classList.add("resizing-col");
        const move = (ev: MouseEvent) => {
          const dx = ev.clientX - start.current.x;
          const w = Math.round(Math.max(min, Math.min(max, start.current.w + (side === "right" ? dx : -dx))));
          useApp.getState().setPanels({ [panel]: w } as Partial<Panels>);
        };
        const up = () => {
          setDragging(false);
          document.body.classList.remove("resizing-col");
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}

export function LeftToggles() {
  const panels = useApp((s) => s.panels);
  const setPanels = useApp((s) => s.setPanels);
  return (
    <div className="panel-toggles no-drag">
      <button className={`icon-btn ${panels.sessions ? "active-soft" : ""}`} title={`${panels.sessions ? "Hide" : "Show"} sessions (${MOD}\\)`} onClick={() => setPanels({ sessions: !panels.sessions })}>
        <PanelLeft size={15} />
      </button>
      <button className={`icon-btn ${panels.explorer ? "active-soft" : ""}`} title={`${panels.explorer ? "Hide" : "Show"} files (${MOD}B)`} onClick={() => setPanels({ explorer: !panels.explorer })}>
        <FolderTree size={15} />
      </button>
    </div>
  );
}

export function RightToggle() {
  const panels = useApp((s) => s.panels);
  const setPanels = useApp((s) => s.setPanels);
  const project = useApp((s) => s.project);
  const n = useProject((s) => (project ? (s.git[project]?.files.length ?? 0) : 0));
  return (
    <button className={`icon-btn git-toggle no-drag ${panels.git ? "active-soft" : ""}`} title={`${panels.git ? "Hide" : "Show"} source control (${MOD}⌥B)`} onClick={() => setPanels({ git: !panels.git })}>
      <GitBranch size={15} />
      {n > 0 && !panels.git && <span className="toggle-badge">{n > 99 ? "99+" : n}</span>}
    </button>
  );
}
