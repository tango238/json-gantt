import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toAppError, type AiRunArgs, type AiRunResult, type AiSessionInfo, type OpenResult, type RecentFileEntry } from "./types";

/** invoke() whose rejection is always an AppError. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const openFile = (path: string) => call<OpenResult>("open_file", { path });
export const saveFile = (path: string, document: unknown) => call<void>("save_file", { path, document });
export const getRecentFiles = () => call<RecentFileEntry[]>("get_recent_files");
export const addRecentFile = (path: string) => call<void>("add_recent_file", { path });
export const watchFile = (path: string) => call<void>("watch_file", { path });
export const unwatchFile = () => call<void>("unwatch_file");
export const newWindow = (path: string | null, blank = false) => call<string>("new_window", { path, blank });
export const exportPdf = (svg: string, options: unknown) => call<string | null>("export_pdf", { svg, options });
export const focusWindowWithFile = (path: string) => call<boolean>("focus_window_with_file", { path });
export const takePendingOpen = () => call<string | null>("take_pending_open");

export const aiLocate = () => call<AiSessionInfo>("ai_locate");
export const aiRun = (args: AiRunArgs) => call<AiRunResult>("ai_run", { ...args });
/** Stops run `runId` (also when it has not registered on the Rust side yet); `null` stops whatever runs. */
export const aiStop = (runId: string | null = null) => call<void>("ai_stop", { runId });
export const aiReset = () => call<void>("ai_reset");
export const aiSetClaudePath = (path: string) => call<string>("ai_set_claude_path", { path });

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

/** File picker; null when cancelled. */
export async function openDialog(): Promise<string | null> {
  const r = await open({ multiple: false, directory: false, filters: JSON_FILTER });
  return typeof r === "string" ? r : null;
}
export async function saveDialog(defaultPath: string): Promise<string | null> {
  return save({ defaultPath, filters: JSON_FILTER });
}

export const setWindowTitle = (title: string) => getCurrentWindow().setTitle(title);
export const destroyWindow = () => getCurrentWindow().destroy();
