import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AiEventPayload, FileChangedPayload, MenuActionPayload, OpenFileRequestedPayload } from "./types";

export const onMenuAction = (cb: (p: MenuActionPayload) => void): Promise<UnlistenFn> =>
  listen<MenuActionPayload>("menu-action", (e) => cb(e.payload));

export const onOpenFileRequested = (cb: (p: OpenFileRequestedPayload) => void): Promise<UnlistenFn> =>
  listen<OpenFileRequestedPayload>("open-file-requested", (e) => cb(e.payload));

export const onFileChangedExternally = (cb: (p: FileChangedPayload) => void): Promise<UnlistenFn> =>
  listen<FileChangedPayload>("file-changed-externally", (e) => cb(e.payload));

export const onAiEvent = (cb: (p: AiEventPayload) => void): Promise<UnlistenFn> =>
  listen<AiEventPayload>("ai-event", (e) => cb(e.payload));

export const onCloseRequested = (cb: (e: { preventDefault(): void }) => void): Promise<UnlistenFn> =>
  getCurrentWindow().onCloseRequested((e) => cb(e));

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
}
export const onDragDrop = (cb: (p: DragDropPayload) => void): Promise<UnlistenFn> =>
  getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    cb({ type: p.type, paths: "paths" in p ? p.paths : [] });
  });
