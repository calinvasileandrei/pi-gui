import { newWorktreeDialog } from "./components/WorktreeDialogs.tsx";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { boot, openViewer, switchProject, useApp, type Page } from "./store.ts";
import { applyTheme } from "./theme.ts";
import "./styles.css";

applyTheme();
// Mac app: leave room for the traffic lights in the hidden-inset title bar
if (/Electron/.test(navigator.userAgent) && /Mac/.test(navigator.platform)) document.documentElement.classList.add("is-mac-electron");

/** Deep links: #page=agents  #session=<id>&tab=changes  #term=1  (also used by the app's self-screenshot checks) */
function applyDeepLink() {
  const h = location.hash;
  if (!h || h === "#") return;
  const get = (k: string) => h.match(new RegExp(`[#&]${k}=([\\w-]+)`))?.[1];
  const st = useApp.getState();
  const sess = get("session");
  if (sess) {
    if (st.sessions.some((s) => s.id === sess)) st.setActive(sess);
    else useApp.setState({ activeId: sess, page: "session" });
  }
  const proj = h.match(/[#&]project=([^&]+)/)?.[1];
  if (proj) switchProject(decodeURIComponent(proj)); // before page=, which it would otherwise reset
  const page = get("page") as Page | undefined;
  if (page) st.setPage(page);
  else if (sess) st.setPage("session");
  const tab = get("tab");
  if (tab === "runs" || tab === "chat") st.setTab(tab);
  else if (sess) st.setTab("chat");
  if (get("term")) st.setTerm({ open: get("term") === "1" });
  for (const k of ["sessions", "explorer", "git"] as const) if (get(k)) st.setPanels({ [k]: get(k) === "1" });
  const file = h.match(/[#&]file=([^&]+)/)?.[1];
  if (file && st.project) openViewer({ kind: "file", root: st.project, cwd: st.project, path: decodeURIComponent(file) });
  const diff = h.match(/[#&]diff=([^&]+)/)?.[1];
  if (diff && st.project) openViewer({ kind: "diff", root: st.project, cwd: st.project, path: decodeURIComponent(diff) });
  if (get("wt") === "new" && useApp.getState().project) newWorktreeDialog(useApp.getState().project!);
  const theme = get("theme");
  if (theme === "light" || theme === "dark" || theme === "system") applyTheme(theme);
  // never leave the token in the address bar
  if (/token=/.test(h)) {
    const rest = h.replace(/^#/, "").split("&").filter((x) => x && !x.startsWith("token=")).join("&");
    history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  }
}

boot();
applyDeepLink();
window.addEventListener("hashchange", applyDeepLink);
createRoot(document.getElementById("root")!).render(<App />);
