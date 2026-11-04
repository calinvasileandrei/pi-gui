// Sandboxed preload: exposes a minimal surface to the page — folder picker, reveal in Finder,
// and the on-disk path of a file dropped from Finder (File.path is gone in modern Electron).
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("piGui", {
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("pi-gui:pick-folder"),
  reveal: (path: string): Promise<boolean> => ipcRenderer.invoke("pi-gui:reveal", path),
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
