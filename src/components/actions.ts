// Executes keymap Actions / toolbar commands against the store. Command errors become toasts.
import {
  getChildren,
  getDescendants,
  nextSibling,
  previousSibling,
  type Command,
} from "../engine";
import { t } from "../i18n";
import { idKey } from "../model/id";
import { useAppStore, type CommandResult } from "../store/appStore";
import { selectVisibleRowIds, treeIndexOf, visibleAncestorOf } from "../store/selectors";
import type { Action } from "./keymap";
import { requestConfirm, showCommandError } from "./uiStore";

/** Dispatch a command; a rejected command is reported as a toast. */
export function runCommand(cmd: Command): CommandResult {
  const res = useAppStore.getState().dispatch(cmd);
  if (!res.ok) showCommandError(res);
  return res;
}

/** Delete the selected dependency or task; a parent asks for confirmation first (03 section 11.4). */
export function deleteSelection(): void {
  const s = useAppStore.getState();
  if (s.doc === null) return;
  if (s.selectedDependency) {
    runCommand({ type: "removeDependency", ...s.selectedDependency });
    return;
  }
  const id = s.selectedId;
  if (id === null) return;
  const ix = treeIndexOf(s.doc);
  const task = ix.byId.get(idKey(id));
  if (!task) return;
  if (getChildren(ix, id).length > 0) {
    requestConfirm({
      message: t("dialog.confirmDeleteParent", { name: task.name, count: getDescendants(ix, id).length }),
      confirmLabel: t("dialog.delete"),
      onConfirm: () => {
        runCommand({ type: "deleteTask", id });
      },
    });
    return;
  }
  runCommand({ type: "deleteTask", id });
}

/** Enabled state of the selection-dependent buttons (03 section 8.1). */
export interface SelectionCaps {
  hasSelection: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}
export function selectionCaps(
  doc: Parameters<typeof treeIndexOf>[0] | null,
  selectedId: string | null,
): SelectionCaps {
  const none = { hasSelection: false, canIndent: false, canOutdent: false, canMoveUp: false, canMoveDown: false };
  if (!doc || selectedId === null) return none;
  const ix = treeIndexOf(doc);
  const task = ix.byId.get(idKey(selectedId));
  if (!task) return none;
  const prev = previousSibling(ix, selectedId);
  return {
    hasSelection: true,
    canIndent: prev !== null,
    canOutdent: (task.parentId ?? null) !== null,
    canMoveUp: prev !== null,
    canMoveDown: nextSibling(ix, selectedId) !== null,
  };
}

export interface ActionHandlers {
  onSave?: () => void;
  onSaveAs?: () => void;
  onExportPdf?: () => void;
}

/** Execute one keymap action. */
export function performAction(a: Action, h: ActionHandlers = {}): void {
  const s = useAppStore.getState();
  if (s.doc === null) return;
  const sel = s.selectedId;

  switch (a.type) {
    case "undo":
      s.undo();
      return;
    case "redo":
      s.redo();
      return;
    case "save":
      h.onSave?.();
      return;
    case "saveAs":
      h.onSaveAs?.();
      return;
    case "exportPdf":
      h.onExportPdf?.();
      return;
    case "addTask":
      runCommand({ type: "addTask", afterId: sel });
      return;
    case "editName":
      if (sel !== null) {
        // A selection hidden by a collapsed ancestor has no row to edit: move to the visible ancestor.
        const target = visibleAncestorOf(s.doc, sel);
        if (idKey(target) !== idKey(sel)) s.select(target);
        s.setEditing({ taskId: target, field: "name" });
      }
      return;
    case "deleteSelected":
      deleteSelection();
      return;
    case "indent":
    case "outdent":
    case "moveUp":
    case "moveDown":
    case "duplicate":
      if (sel !== null) runCommand({ type: a.type === "duplicate" ? "duplicateTask" : a.type, id: sel });
      return;
    case "selectPrev":
    case "selectNext": {
      const rows = selectVisibleRowIds(s);
      if (rows.length === 0) return;
      // A selection hidden by a collapsed ancestor navigates from that ancestor's row.
      const from = sel === null ? null : visibleAncestorOf(s.doc, sel);
      const i = from === null ? -1 : rows.findIndex((r) => idKey(r) === idKey(from));
      const next = a.type === "selectPrev" ? (i < 0 ? rows.length - 1 : i - 1) : i + 1;
      const id = rows[Math.min(rows.length - 1, Math.max(0, next))];
      if (id !== undefined) s.select(id);
      return;
    }
    case "collapse": {
      if (sel === null) return;
      const ix = treeIndexOf(s.doc);
      const collapsed = (s.doc.view?.collapsedTaskIds ?? []).some((c) => idKey(c) === idKey(sel));
      if (getChildren(ix, sel).length > 0 && !collapsed) {
        s.toggleCollapsed(sel);
      } else {
        const parent = ix.parentOf.get(idKey(sel));
        if (parent) s.select(parent);
      }
      return;
    }
    case "expand": {
      if (sel === null) return;
      const ix = treeIndexOf(s.doc);
      const collapsed = (s.doc.view?.collapsedTaskIds ?? []).some((c) => idKey(c) === idKey(sel));
      if (getChildren(ix, sel).length > 0 && collapsed) s.toggleCollapsed(sel);
      return;
    }
    case "zoom":
      s.setZoom(a.zoom);
      return;
    case "escape":
      if (s.selectedDependency) s.selectDependency(null);
      return;
  }
}
