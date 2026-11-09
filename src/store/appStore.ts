import { applyPatches, enablePatches, produce, type Patch } from "immer";
import { create } from "zustand";
import {
  buildTreeIndex,
  collapseAll as collapseAllView,
  executeCommand,
  expandAll as expandAllView,
  revealTask,
  toggleCollapsed as toggleCollapsedView,
  type Command,
  type CommandContext,
  type CommandErr,
  type CommandOk,
  type LoadIssue,
} from "../engine";
import { t } from "../i18n";
import { idKey, newId } from "../model/id";
import { todayIso } from "../model/date";
import type { GanttDocument, Zoom } from "../model/types";

enablePatches();

export const UNDO_LIMIT = 200;

export interface UndoEntry {
  id: number;
  patches: Patch[];
  inversePatches: Patch[];
  label: Command["type"];
}

export type EditingState = { taskId: string; field: "name" | "duration" | "hours" } | null;
export type CommandResult = CommandOk | CommandErr;

export interface AppState {
  filePath: string | null;
  doc: GanttDocument | null;
  /** Transient document shown while dragging. Never committed. */
  preview: GanttDocument | null;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** id of the undo-stack top at save time (null = empty stack). */
  savedUndoId: number | null;
  viewDirty: boolean;
  selectedId: string | null;
  selectedDependency: { succId: string; predId: string } | null;
  editing: EditingState;
  valueColumn: "duration" | "hours";
  sidePanelOpen: boolean;
  sidePanelTab: "project" | "tasks";
  loadWarnings: LoadIssue[];
  /** Incremented on every loadDocument (lets the view reset its scroll position per load). */
  loadCount: number;

  loadDocument(path: string | null, doc: GanttDocument, warnings?: LoadIssue[]): void;
  dispatch(cmd: Command): CommandResult;
  undo(): void;
  redo(): void;
  setPreview(doc: GanttDocument): void;
  clearPreview(): void;
  setZoom(z: Zoom): void;
  toggleCollapsed(id: string): void;
  expandAll(): void;
  collapseAll(): void;
  /** `top` / `view`: undo head id and view captured when the save started (edits during the save stay dirty). */
  markSaved(path: string, top: number | null, view: GanttDocument["view"]): void;

  select(id: string | null): void;
  selectDependency(dep: { succId: string; predId: string } | null): void;
  setEditing(e: EditingState): void;
  setValueColumn(c: "duration" | "hours"): void;
  setSidePanelOpen(open: boolean): void;
  setSidePanelTab(tab: "project" | "tasks"): void;
}

// ---------------------------------------------------------------------------
// Command context (injectable for tests)
// ---------------------------------------------------------------------------

let ctxOverride: Partial<CommandContext> | null = null;

/** Override parts of the command context (id generator, today, default name). Pass null to reset. */
export function setCommandContextOverride(o: Partial<CommandContext> | null): void {
  ctxOverride = o;
}

function makeCtx(): CommandContext {
  return {
    today: todayIso(),
    newId,
    defaultTaskName: t("task.defaultName"),
    ...ctxOverride,
  };
}

let nextUndoId = 1;

function taskExists(doc: GanttDocument, id: string): boolean {
  const k = idKey(id);
  return doc.tasks.some((t) => idKey(t.id) === k);
}

/** Drop selection / editing state that points at tasks which no longer exist. */
function sanitizeUi(s: AppState, doc: GanttDocument): Partial<AppState> {
  const out: Partial<AppState> = {};
  if (s.selectedId !== null && !taskExists(doc, s.selectedId)) out.selectedId = null;
  const dep = s.selectedDependency;
  if (dep !== null) {
    const succ = doc.tasks.find((t) => idKey(t.id) === idKey(dep.succId));
    const ok = succ?.dependencies?.some((d) => idKey(d.predecessorId) === idKey(dep.predId)) ?? false;
    if (!ok) out.selectedDependency = null;
  }
  if (s.editing !== null && !taskExists(doc, s.editing.taskId)) out.editing = null;
  return out;
}

export const useAppStore = create<AppState>()((set, get) => ({
  filePath: null,
  doc: null,
  preview: null,
  undoStack: [],
  redoStack: [],
  savedUndoId: null,
  viewDirty: false,
  selectedId: null,
  selectedDependency: null,
  editing: null,
  valueColumn: "duration",
  sidePanelOpen: true,
  sidePanelTab: "tasks",
  loadWarnings: [],
  loadCount: 0,

  loadDocument(path, doc, warnings = []) {
    set({
      loadCount: get().loadCount + 1,
      filePath: path,
      doc,
      preview: null,
      undoStack: [],
      redoStack: [],
      savedUndoId: null,
      viewDirty: false,
      selectedId: null,
      selectedDependency: null,
      editing: null,
      loadWarnings: warnings,
    });
  },

  dispatch(cmd) {
    const s = get();
    if (s.doc === null) return { ok: false, code: "TASK_NOT_FOUND" };
    const res = executeCommand(s.doc, cmd, makeCtx());
    if (!res.ok) return res;

    let doc = res.doc;
    let viewDirty = s.viewDirty;
    if (res.reveal && res.reveal.length > 0) {
      const ix = buildTreeIndex(doc);
      let view = doc.view ?? { zoom: "day" as Zoom, collapsedTaskIds: [] };
      for (const id of res.reveal) view = revealTask(view, ix, id);
      if (view !== (doc.view ?? view)) {
        const v = view;
        doc = produce(doc, (d) => {
          d.view = v;
        });
        viewDirty = true;
      }
    }

    const patch: Partial<AppState> = { preview: null, viewDirty };
    if (res.patches.length > 0) {
      const entry: UndoEntry = {
        id: nextUndoId++,
        patches: res.patches,
        inversePatches: res.inversePatches,
        label: cmd.type,
      };
      const undo = [...s.undoStack, entry];
      if (undo.length > UNDO_LIMIT) undo.splice(0, undo.length - UNDO_LIMIT);
      patch.undoStack = undo;
      patch.redoStack = [];
    }
    patch.doc = doc;
    if (res.selection !== undefined) {
      patch.selectedId = res.selection;
      patch.selectedDependency = null;
    }
    if (res.editName && res.selection) {
      patch.editing = { taskId: res.selection, field: "name" };
    }
    set((cur) => ({ ...patch, ...sanitizeUi({ ...cur, ...patch }, doc) }));
    return res;
  },

  undo() {
    const s = get();
    if (s.doc === null || s.undoStack.length === 0) return;
    const entry = s.undoStack[s.undoStack.length - 1]!;
    const doc = applyPatches(s.doc, entry.inversePatches);
    set({
      doc,
      preview: null,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, entry],
      editing: null,
      ...sanitizeUi(s, doc),
    });
  },

  redo() {
    const s = get();
    if (s.doc === null || s.redoStack.length === 0) return;
    const entry = s.redoStack[s.redoStack.length - 1]!;
    const doc = applyPatches(s.doc, entry.patches);
    set({
      doc,
      preview: null,
      undoStack: [...s.undoStack, entry],
      redoStack: s.redoStack.slice(0, -1),
      editing: null,
      ...sanitizeUi(s, doc),
    });
  },

  setPreview(doc) {
    set({ preview: doc });
  },
  clearPreview() {
    if (get().preview !== null) set({ preview: null });
  },

  setZoom(z) {
    const s = get();
    if (s.doc === null || s.doc.view?.zoom === z) return;
    set({
      doc: produce(s.doc, (d) => {
        d.view = { ...(d.view ?? {}), zoom: z } as GanttDocument["view"];
      }),
      viewDirty: true,
    });
  },

  toggleCollapsed(id) {
    const s = get();
    if (s.doc === null) return;
    const view = toggleCollapsedView(s.doc.view ?? { zoom: "day", collapsedTaskIds: [] }, id);
    applyView(view);
  },
  expandAll() {
    const s = get();
    if (s.doc === null) return;
    applyView(expandAllView(s.doc.view ?? { zoom: "day", collapsedTaskIds: [] }));
  },
  collapseAll() {
    const s = get();
    if (s.doc === null) return;
    applyView(collapseAllView(s.doc.view ?? { zoom: "day", collapsedTaskIds: [] }, buildTreeIndex(s.doc)));
  },

  markSaved(path, top, view) {
    set({
      filePath: path,
      savedUndoId: top,
      viewDirty: get().doc?.view !== view,
    });
  },

  select(id) {
    set({ selectedId: id, selectedDependency: null });
  },
  selectDependency(dep) {
    set({ selectedDependency: dep, ...(dep ? { selectedId: null } : {}) });
  },
  setEditing(e) {
    set({ editing: e });
  },
  setValueColumn(c) {
    set({ valueColumn: c });
  },
  setSidePanelOpen(open) {
    set({ sidePanelOpen: open });
  },
  setSidePanelTab(tab) {
    set({ sidePanelTab: tab });
  },
}));

function applyView(view: NonNullable<GanttDocument["view"]>): void {
  const s = useAppStore.getState();
  if (s.doc === null || view === s.doc.view) return;
  // Nothing actually changed (e.g. collapseAll when already collapsed): stay clean.
  const before = new Set((s.doc.view?.collapsedTaskIds ?? []).map(idKey));
  const after = new Set((view.collapsedTaskIds ?? []).map(idKey));
  if (before.size === after.size && [...after].every((k) => before.has(k)) && s.doc.view?.zoom === view.zoom) {
    return;
  }
  useAppStore.setState({
    doc: produce(s.doc, (d) => {
      d.view = view;
    }),
    viewDirty: true,
  });
}
