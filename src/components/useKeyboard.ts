import { useEffect } from "react";
import { isTauri } from "../tauri/isTauri";
import { performAction, type ActionHandlers } from "./actions";
import { isDragActive } from "./chart/useDrag";
import { detectPlatform, mapKey } from "./keymap";

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/** True when `el` is (inside) a text-editing control: Undo / shortcuts must not hijack it. */
export function isEditableTarget(el: Element | null): boolean {
  return el?.closest(EDITABLE) != null;
}

/** Window-level keydown -> keymap -> store (03 section 8.2). */
export function useKeyboard(handlers: ActionHandlers = {}): void {
  const { onSave, onSaveAs, onExportPdf } = handlers;
  useEffect(() => {
    const platform = detectPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // A focused button handles Enter / Space itself.
      if (target?.closest("button") && (e.key === "Enter" || e.key === " ")) return;
      const action = mapKey(e, {
        platform,
        isTauri: isTauri(),
        editing: isEditableTarget(target),
        dragging: isDragActive(),
        modalOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
      });
      if (action === null) return;
      e.preventDefault();
      // Holding a key must not repeat commands (Enter / Delete ...); only row navigation repeats.
      if (e.repeat && action.type !== "selectPrev" && action.type !== "selectNext") return;
      performAction(action, { onSave, onSaveAs, onExportPdf });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSave, onSaveAs, onExportPdf]);
}
