/** True when running inside the Tauri webview (false in a plain browser, e.g. `pnpm dev`). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
