import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GuiSettingsSchema, type GuiSettings } from "@pi-gui/protocol";

export const GUI_DIR = process.env.PI_GUI_HOME ?? join(homedir(), ".pi-gui");
export const SETTINGS_FILE = join(GUI_DIR, "settings.json");

export async function loadSettings(): Promise<{ settings: GuiSettings; error?: string }> {
  const raw = await readFile(SETTINGS_FILE, "utf8").catch(() => null);
  if (raw === null) return { settings: GuiSettingsSchema.parse({}) };
  try {
    const r = GuiSettingsSchema.safeParse(JSON.parse(raw));
    if (r.success) return { settings: r.data };
    return { settings: GuiSettingsSchema.parse({}), error: r.error.message };
  } catch (e) {
    return { settings: GuiSettingsSchema.parse({}), error: (e as Error).message };
  }
}

export async function saveSettings(s: GuiSettings): Promise<void> {
  await mkdir(GUI_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}
