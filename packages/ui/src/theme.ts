export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  try {
    return (localStorage.getItem("pi-gui-theme") as Theme) || "system";
  } catch {
    return "system";
  }
}

/** data-theme on <html>: CSS tokens honour it over prefers-color-scheme. */
export function applyTheme(t: Theme = getTheme()) {
  const el = document.documentElement;
  if (t === "system") delete el.dataset.theme;
  else el.dataset.theme = t;
  try {
    localStorage.setItem("pi-gui-theme", t);
  } catch {
    /* ignore */
  }
}

export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
};
