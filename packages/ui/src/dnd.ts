// Drag & drop payloads shared by the explorer, the composer and the terminal.
import { native } from "./store.ts";

export const PI_PATH = "application/x-pi-path";

export interface InternalDrag {
  /** project folder the paths are relative to */
  root: string;
  paths: string[];
}

export function setInternalDrag(dt: DataTransfer, d: InternalDrag) {
  dt.setData(PI_PATH, JSON.stringify(d));
  dt.setData("text/plain", d.paths.map((p) => `${d.root}/${p}`).join(" "));
  dt.effectAllowed = "copyMove";
}

export const hasInternal = (dt: DataTransfer | null) => !!dt && [...dt.types].includes(PI_PATH);
export const hasFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes("Files");

export function readInternal(dt: DataTransfer): InternalDrag | undefined {
  try {
    const v = JSON.parse(dt.getData(PI_PATH)) as InternalDrag;
    return v && typeof v.root === "string" && Array.isArray(v.paths) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Dropped OS files: absolute paths in the Mac app; in a browser only the File objects. */
export function droppedFiles(dt: DataTransfer): { files: File[]; paths: string[] } {
  const files = [...dt.files];
  const pathFor = native().pathForFile;
  const paths = pathFor ? files.map((f) => pathFor(f)).filter(Boolean) : [];
  return { files, paths };
}

export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.readAsDataURL(f);
  });
}

/** shell-quote a path for pasting into a terminal */
export const shq = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
