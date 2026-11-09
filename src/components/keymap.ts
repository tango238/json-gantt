// Pure keyboard mapping (03 section 8.2). No DOM access: the caller describes the key event
// and the current context, and gets back an Action (or null = not handled here).
import type { Zoom } from "../model/types";

export type Platform = "mac" | "windows";

export type Action =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "save" }
  | { type: "saveAs" }
  | { type: "exportPdf" }
  | { type: "addTask" }
  | { type: "editName" }
  | { type: "deleteSelected" }
  | { type: "indent" }
  | { type: "outdent" }
  | { type: "moveUp" }
  | { type: "moveDown" }
  | { type: "duplicate" }
  | { type: "selectPrev" }
  | { type: "selectNext" }
  | { type: "collapse" }
  | { type: "expand" }
  | { type: "zoom"; zoom: Zoom }
  /** Clear the dependency (arrow) selection. */
  | { type: "escape" };

/** The parts of a KeyboardEvent the mapping needs. */
export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  /** 229 = IME is processing the key (WKWebView reports the commit Enter this way). */
  keyCode?: number;
}

export interface KeyContext {
  platform: Platform;
  isTauri: boolean;
  /** Focus is in input / textarea / select / contenteditable. */
  editing: boolean;
  /** A drag is in progress (everything is ignored; useDrag handles Escape). */
  dragging: boolean;
  /** A modal dialog is open. */
  modalOpen: boolean;
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "windows";
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(p) ? "mac" : "windows";
}

const ZOOMS: Record<string, Zoom> = { "1": "day", "2": "week", "3": "month" };

export function mapKey(e: KeyInput, ctx: KeyContext): Action | null {
  if (ctx.dragging || ctx.modalOpen) return null;
  if (e.isComposing || e.keyCode === 229) return null;

  const mac = ctx.platform === "mac";
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod && !e.altKey) {
    // File / history shortcuts belong to the native menu inside Tauri; the browser build
    // handles them here as a development fallback.
    if (key === "z") {
      if (ctx.isTauri || ctx.editing) return null; // menu, or the input's own undo
      return e.shiftKey ? { type: "redo" } : { type: "undo" };
    }
    if (key === "s") {
      if (ctx.isTauri) return null;
      return e.shiftKey ? { type: "saveAs" } : { type: "save" };
    }
    if (key === "e" && e.shiftKey) return ctx.isTauri ? null : { type: "exportPdf" };
    if (!mac && key === "y" && !e.shiftKey) return ctx.editing ? null : { type: "redo" };

    if (ctx.editing) return null;
    if (e.shiftKey) return null;
    if (key === "d") return { type: "duplicate" };
    const z = ZOOMS[key];
    if (z) return { type: "zoom", zoom: z };
    return null;
  }
  if (e.metaKey || e.ctrlKey) return null;
  if (ctx.editing) return null;

  if (e.altKey) {
    if (e.shiftKey) return null;
    if (key === "ArrowUp") return { type: "moveUp" };
    if (key === "ArrowDown") return { type: "moveDown" };
    return null;
  }

  switch (key) {
    case "Enter":
      return e.shiftKey ? null : { type: "addTask" };
    case "F2":
      return { type: "editName" };
    case "Delete":
    case "Backspace":
      return { type: "deleteSelected" };
    case "Tab":
      return e.shiftKey ? { type: "outdent" } : { type: "indent" };
    case "ArrowUp":
      return { type: "selectPrev" };
    case "ArrowDown":
      return { type: "selectNext" };
    case "ArrowLeft":
      return { type: "collapse" };
    case "ArrowRight":
      return { type: "expand" };
    case "Escape":
      return { type: "escape" };
    default:
      return null;
  }
}

/** "Mod+Shift+Z" -> "⌘⇧Z" (mac) / "Ctrl+Shift+Z" (windows). */
export function formatShortcut(platform: Platform, combo: string): string {
  const parts = combo.split("+");
  if (platform === "mac") {
    const glyph: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };
    return parts.map((p) => glyph[p] ?? p).join("");
  }
  return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
}
