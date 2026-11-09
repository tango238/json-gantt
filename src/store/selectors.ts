import {
  buildTreeIndex,
  compileCalendar,
  deriveAll,
  findViolations,
  getAncestors,
  visibleRows,
  type DerivedIndex,
  type TreeIndex,
  type Violation,
  type WorkCalendar,
} from "../engine";
import { idKey } from "../model/id";
import type { GanttDocument, Task, Zoom } from "../model/types";
import type { AppState } from "./appStore";

type S = Pick<AppState, "doc" | "preview">;

interface Memo {
  wc?: WorkCalendar;
  ix?: TreeIndex;
  derived?: DerivedIndex;
  violations?: Violation[];
  rows?: string[];
  serial?: Map<string, number>;
}
const memo = new WeakMap<GanttDocument, Memo>();
function m(doc: GanttDocument): Memo {
  let e = memo.get(doc);
  if (!e) memo.set(doc, (e = {}));
  return e;
}

/** Document to display: the drag preview if any, else the committed doc. */
export const displayDoc = (s: S): GanttDocument | null => s.preview ?? s.doc;

// All doc-based selectors below are memoised per document object (reference-stable results).
export const calendarOf = (doc: GanttDocument): WorkCalendar => (m(doc).wc ??= compileCalendar(doc.project.calendar));
export const treeIndexOf = (doc: GanttDocument): TreeIndex => (m(doc).ix ??= buildTreeIndex(doc));
export const derivedOf = (doc: GanttDocument): DerivedIndex =>
  (m(doc).derived ??= deriveAll(doc, calendarOf(doc)));
export const violationsOf = (doc: GanttDocument): Violation[] =>
  (m(doc).violations ??= findViolations(doc, calendarOf(doc)));

/** idKey -> serial number (1-based index in doc order, independent of collapsing). Memoised per document. */
export const serialNosOf = (doc: GanttDocument): ReadonlyMap<string, number> =>
  (m(doc).serial ??= new Map(derivedOf(doc).order.map((id, i) => [idKey(id), i + 1] as const)));

const EMPTY: never[] = [];

export const selectWorkCalendar = (s: S): WorkCalendar | null => {
  const d = displayDoc(s);
  return d ? calendarOf(d) : null;
};
export const selectDerived = (s: S): DerivedIndex | null => {
  const d = displayDoc(s);
  return d ? derivedOf(d) : null;
};
export const selectViolations = (s: S): readonly Violation[] => {
  const d = displayDoc(s);
  return d ? violationsOf(d) : EMPTY;
};
export const selectZoom = (s: S): Zoom => displayDoc(s)?.view?.zoom ?? "day";

/** Visible row ids (depth-first, collapsed subtrees skipped). Memoised per document. */
export function selectVisibleRowIds(s: S): readonly string[] {
  const d = displayDoc(s);
  if (!d) return EMPTY;
  const e = m(d);
  return (e.rows ??= visibleRows(treeIndexOf(d), new Set(d.view?.collapsedTaskIds ?? [])));
}

/**
 * The row to use when `id` is hidden by a collapsed ancestor: the outermost collapsed ancestor
 * (the nearest ancestor that is itself visible). Returns `id` when it is already visible.
 */
export function visibleAncestorOf(doc: GanttDocument, id: string): string {
  const ix = treeIndexOf(doc);
  const collapsed = new Set((doc.view?.collapsedTaskIds ?? []).map(idKey));
  if (collapsed.size === 0) return id;
  const ancestors = getAncestors(ix, id); // nearest first
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (collapsed.has(idKey(ancestors[i]!))) return ancestors[i]!;
  }
  return id;
}

export const selectSelectedTask = (s: S & Pick<AppState, "selectedId">): Task | null => {
  const d = displayDoc(s);
  if (!d || s.selectedId === null) return null;
  return treeIndexOf(d).byId.get(idKey(s.selectedId)) ?? null;
};
export const isDirty = (s: Pick<AppState, "undoStack" | "savedUndoId" | "viewDirty">): boolean =>
  (s.undoStack.length > 0 ? s.undoStack[s.undoStack.length - 1]!.id : null) !== s.savedUndoId || s.viewDirty;
export const canUndo = (s: Pick<AppState, "undoStack">): boolean => s.undoStack.length > 0;
export const canRedo = (s: Pick<AppState, "redoStack">): boolean => s.redoStack.length > 0;
