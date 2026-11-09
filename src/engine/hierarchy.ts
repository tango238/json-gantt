import { idKey } from "../model/id";
import type { GanttDocument, IsoDate, Task, ViewSettings } from "../model/types";
import { durationOf, type WorkCalendar } from "./calendar";
import { CommandRejected } from "./errors";

// ---------------------------------------------------------------------------
// Tree index (02 section 2.1)
// ---------------------------------------------------------------------------

/**
 * All map keys are idKey(id). Values of childrenOf are the original id strings,
 * in array-relative order. parentOf values are original ids (null = root).
 */
export interface TreeIndex {
  byId: Map<string, Task>;
  childrenOf: Map<string | null, string[]>;
  parentOf: Map<string, string | null>;
}

export function buildTreeIndex(doc: GanttDocument): TreeIndex {
  const byId = new Map<string, Task>();
  const childrenOf = new Map<string | null, string[]>();
  const parentOf = new Map<string, string | null>();
  for (const t of doc.tasks) {
    const k = idKey(t.id);
    if (!byId.has(k)) byId.set(k, t);
  }
  for (const t of doc.tasks) {
    const parent = t.parentId ?? null;
    const pk = parent === null ? null : idKey(parent);
    parentOf.set(idKey(t.id), parent);
    let list = childrenOf.get(pk);
    if (!list) {
      list = [];
      childrenOf.set(pk, list);
    }
    list.push(t.id);
  }
  return { byId, childrenOf, parentOf };
}

const NO_IDS: string[] = [];

export function getChildren(ix: TreeIndex, id: string | null): string[] {
  return ix.childrenOf.get(id === null ? null : idKey(id)) ?? NO_IDS;
}

export function isParent(ix: TreeIndex, id: string): boolean {
  return getChildren(ix, id).length > 0;
}

export function getDepth(ix: TreeIndex, id: string): number {
  return getAncestors(ix, id).length;
}

/** Nearest first: parent, grandparent, ... */
export function getAncestors(ix: TreeIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([idKey(id)]);
  let cur = ix.parentOf.get(idKey(id)) ?? null;
  while (cur !== null) {
    const k = idKey(cur);
    if (seen.has(k)) break; // defensive: corrupted parent cycle
    seen.add(k);
    out.push(cur);
    cur = ix.parentOf.get(k) ?? null;
  }
  return out;
}

/** Pre-order, excluding id itself. */
export function getDescendants(ix: TreeIndex, id: string): string[] {
  const out: string[] = [];
  const stack = [...getChildren(ix, id)].reverse();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    const ch = getChildren(ix, cur);
    for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]!);
  }
  return out;
}

export function getLeafDescendantsOrSelf(ix: TreeIndex, id: string): string[] {
  if (!isParent(ix, id)) return [id];
  return getDescendants(ix, id).filter((d) => !isParent(ix, d));
}

/** [start index, end index) of the subtree in doc.tasks (contiguous in pre-order). */
export function getSubtreeRange(doc: GanttDocument, ix: TreeIndex, id: string): [number, number] {
  const k = idKey(id);
  const start = doc.tasks.findIndex((t) => idKey(t.id) === k);
  if (start < 0) throw new CommandRejected("TASK_NOT_FOUND", { id });
  return [start, start + 1 + getDescendants(ix, id).length];
}

/** All ids in pre-order. */
export function displayOrder(ix: TreeIndex): string[] {
  const out: string[] = [];
  const roots = getChildren(ix, null);
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    const ch = getChildren(ix, cur);
    for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]!);
  }
  return out;
}

/** Rows that have no collapsed ancestor. A collapsed parent itself stays visible. */
export function visibleRows(ix: TreeIndex, collapsed: ReadonlySet<string>): string[] {
  const keys = new Set<string>();
  for (const c of collapsed) keys.add(idKey(c));
  const out: string[] = [];
  // Iterative for deep trees.
  const stack: string[] = [...getChildren(ix, null)].reverse();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    if (keys.has(idKey(cur))) continue;
    const ch = getChildren(ix, cur);
    for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]!);
  }
  return out;
}

export function previousSibling(ix: TreeIndex, id: string): string | null {
  const parent = ix.parentOf.get(idKey(id));
  if (parent === undefined) return null;
  const sibs = getChildren(ix, parent);
  const k = idKey(id);
  const i = sibs.findIndex((s) => idKey(s) === k);
  return i > 0 ? sibs[i - 1]! : null;
}

export function nextSibling(ix: TreeIndex, id: string): string | null {
  const parent = ix.parentOf.get(idKey(id));
  if (parent === undefined) return null;
  const sibs = getChildren(ix, parent);
  const k = idKey(id);
  const i = sibs.findIndex((s) => idKey(s) === k);
  return i >= 0 && i < sibs.length - 1 ? sibs[i + 1]! : null;
}

/** Effective start: leaf's own start, parent's min over leaf descendants. */
export function effectiveStart(ix: TreeIndex, id: string): IsoDate {
  const leaves = getLeafDescendantsOrSelf(ix, id);
  let min = "";
  for (const l of leaves) {
    const s = ix.byId.get(idKey(l))!.start!;
    if (min === "" || s < min) min = s;
  }
  return min;
}

/** Effective end: leaf's own end, parent's max over leaf descendants. */
export function effectiveEnd(ix: TreeIndex, id: string): IsoDate {
  const leaves = getLeafDescendantsOrSelf(ix, id);
  let max = "";
  for (const l of leaves) {
    const e = ix.byId.get(idKey(l))!.end!;
    if (e > max) max = e;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Derived values (02 section 2.2, 2.3; 01 section 4.3)
// ---------------------------------------------------------------------------

export interface DerivedTask {
  id: string;
  isParent: boolean;
  depth: number;
  childIds: string[];
  start: IsoDate;
  end: IsoDate;
  durationDays: number;
  hours: number | undefined;
  progress: number;
}

export interface DerivedIndex {
  byId: Map<string, DerivedTask>;
  order: string[];
  rootIds: string[];
}

export function weightedProgress(children: readonly DerivedTask[]): number {
  if (children.length === 0) return 0;
  let hoursSum = 0;
  let allHours = true;
  for (const c of children) {
    if (c.hours === undefined) allHours = false;
    else hoursSum += c.hours;
  }
  if (allHours && hoursSum > 0) {
    let acc = 0;
    for (const c of children) acc += c.hours! * c.progress;
    return acc / hoursSum;
  }
  let wSum = 0;
  let acc = 0;
  for (const c of children) {
    wSum += c.durationDays;
    acc += c.durationDays * c.progress;
  }
  if (wSum > 0) return acc / wSum;
  let plain = 0;
  for (const c of children) plain += c.progress;
  return plain / children.length;
}

export function deriveAll(doc: GanttDocument, wc: WorkCalendar): DerivedIndex {
  const ix = buildTreeIndex(doc);
  const order = displayOrder(ix);
  const byId = new Map<string, DerivedTask>();
  const depthOf = new Map<string, number>();
  for (const id of order) {
    const parent = ix.parentOf.get(idKey(id)) ?? null;
    depthOf.set(idKey(id), parent === null ? 0 : (depthOf.get(idKey(parent)) ?? 0) + 1);
  }
  // Pre-order reversed visits every child before its parent.
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const task = ix.byId.get(idKey(id))!;
    const childIds = getChildren(ix, id);
    const depth = depthOf.get(idKey(id)) ?? 0;
    if (childIds.length === 0) {
      const start = task.start!;
      const end = task.end!;
      byId.set(idKey(id), {
        id,
        isParent: false,
        depth,
        childIds: [],
        start,
        end,
        durationDays: durationOf(start, end, wc),
        hours: task.hours,
        progress: task.progress ?? 0,
      });
      continue;
    }
    const kids = childIds.map((c) => byId.get(idKey(c))!);
    let start = kids[0]!.start;
    let end = kids[0]!.end;
    let hours: number | undefined;
    for (const k of kids) {
      if (k.start < start) start = k.start;
      if (k.end > end) end = k.end;
      if (k.hours !== undefined) hours = (hours ?? 0) + k.hours;
    }
    byId.set(idKey(id), {
      id,
      isParent: true,
      depth,
      childIds: [...childIds],
      start,
      end,
      durationDays: durationOf(start, end, wc),
      hours,
      progress: weightedProgress(kids),
    });
  }
  const rootIds = [...getChildren(ix, null)];
  return { byId, order, rootIds };
}

export function getDerived(derived: DerivedIndex, id: string): DerivedTask | undefined {
  return derived.byId.get(idKey(id));
}

/** Project-level progress: root tasks treated as children of a virtual parent. */
export function projectProgress(derived: DerivedIndex): number {
  if (derived.rootIds.length === 0) return 0;
  return weightedProgress(derived.rootIds.map((id) => derived.byId.get(idKey(id))!));
}

// ---------------------------------------------------------------------------
// Structure mutation (02 section 2.4). All functions mutate an immer draft.
// ---------------------------------------------------------------------------

/** Post-change validity hook (I6/I7). Returns false to reject the change. */
export type StructureCheck = (draft: GanttDocument) => boolean;
const ALWAYS_OK: StructureCheck = () => true;

function requireTask(ix: TreeIndex, id: string): Task {
  const t = ix.byId.get(idKey(id));
  if (!t) throw new CommandRejected("TASK_NOT_FOUND", { id });
  return t;
}

function leafify(task: Task, derived: DerivedTask): void {
  task.start = derived.start;
  task.end = derived.end;
  task.progress = Math.round(derived.progress);
  if (derived.hours !== undefined) task.hours = derived.hours;
}

function stripDerived(task: Task): void {
  delete task.start;
  delete task.end;
  delete task.progress;
  delete task.hours;
}

export function indent(draft: GanttDocument, id: string, check: StructureCheck = ALWAYS_OK): void {
  const ix = buildTreeIndex(draft);
  const task = requireTask(ix, id);
  const prevId = previousSibling(ix, id);
  if (prevId === null) throw new CommandRejected("NO_PREVIOUS_SIBLING", { id });
  const prev = requireTask(ix, prevId);
  task.parentId = prev.id;
  // prev's subtree is directly before task, so the array order is unchanged.
  stripDerived(prev);
  if (!check(draft)) throw new CommandRejected("DEPENDENCY_CONFLICT", { id });
}

/** Returns the old parent's id if it became a leaf, otherwise null. */
export function outdent(
  draft: GanttDocument,
  id: string,
  wc: WorkCalendar,
  check: StructureCheck = ALWAYS_OK,
): string | null {
  const ix = buildTreeIndex(draft);
  const task = requireTask(ix, id);
  const parentId = task.parentId ?? null;
  if (parentId === null) throw new CommandRejected("NOT_INDENTED", { id });
  const parent = requireTask(ix, parentId);
  const derived = deriveAll(draft, wc).byId.get(idKey(parentId))!;

  const [s, e] = getSubtreeRange(draft, ix, id);
  const block = draft.tasks.splice(s, e - s);
  task.parentId = parent.parentId ?? null;

  // Insert directly after the (remaining) subtree of the old parent.
  const ix2 = buildTreeIndex(draft);
  const [, pEnd] = getSubtreeRange(draft, ix2, parentId);
  draft.tasks.splice(pEnd, 0, ...block);

  let becameLeaf: string | null = null;
  if (getChildren(buildTreeIndex(draft), parentId).length === 0) {
    leafify(parent, derived);
    becameLeaf = parentId;
  }
  if (!check(draft)) throw new CommandRejected("DEPENDENCY_CONFLICT", { id });
  return becameLeaf;
}

function swapAdjacentBlocks(draft: GanttDocument, firstId: string, secondId: string): void {
  const ix = buildTreeIndex(draft);
  const [fs, fe] = getSubtreeRange(draft, ix, firstId);
  const [ss, se] = getSubtreeRange(draft, ix, secondId);
  // The first block ends exactly where the second begins (siblings in pre-order).
  const second = draft.tasks.slice(ss, se);
  const first = draft.tasks.slice(fs, fe);
  draft.tasks.splice(fs, se - fs, ...second, ...first);
}

export function moveUp(draft: GanttDocument, id: string): void {
  const ix = buildTreeIndex(draft);
  requireTask(ix, id);
  const prev = previousSibling(ix, id);
  if (prev === null) throw new CommandRejected("NO_PREVIOUS_SIBLING", { id });
  swapAdjacentBlocks(draft, prev, id);
}

export function moveDown(draft: GanttDocument, id: string): void {
  const ix = buildTreeIndex(draft);
  requireTask(ix, id);
  const next = nextSibling(ix, id);
  if (next === null) throw new CommandRejected("NO_NEXT_SIBLING", { id });
  swapAdjacentBlocks(draft, id, next);
}

/** Deletes the tasks and their subtrees. Returns ids of parents that became leaves. */
export function deleteTasks(draft: GanttDocument, ids: readonly string[], wc: WorkCalendar): string[] {
  const ix = buildTreeIndex(draft);
  for (const id of ids) requireTask(ix, id);
  const derived = deriveAll(draft, wc);

  const removed = new Set<string>();
  for (const id of ids) {
    removed.add(idKey(id));
    for (const d of getDescendants(ix, id)) removed.add(idKey(d));
  }
  const affectedParents = new Set<string>();
  for (const k of removed) {
    const p = ix.parentOf.get(k) ?? null;
    if (p !== null && !removed.has(idKey(p))) affectedParents.add(p);
  }

  const kept = draft.tasks.filter((t) => !removed.has(idKey(t.id)));
  draft.tasks.splice(0, draft.tasks.length, ...kept);
  for (const t of draft.tasks) {
    if (!t.dependencies || t.dependencies.length === 0) continue;
    if (t.dependencies.some((d) => removed.has(idKey(d.predecessorId)))) {
      const next = t.dependencies.filter((d) => !removed.has(idKey(d.predecessorId)));
      t.dependencies.splice(0, t.dependencies.length, ...next);
    }
  }

  const ix2 = buildTreeIndex(draft);
  const leafified: string[] = [];
  for (const p of affectedParents) {
    if (getChildren(ix2, p).length === 0) {
      leafify(requireTask(ix2, p), derived.byId.get(idKey(p))!);
      leafified.push(p);
    }
  }
  return leafified;
}

// ---------------------------------------------------------------------------
// View operations (not undoable). Pure: return a new ViewSettings.
// ---------------------------------------------------------------------------

function collapsedList(view: ViewSettings): string[] {
  return view.collapsedTaskIds ?? [];
}

export function setCollapsed(view: ViewSettings, id: string, collapsed: boolean): ViewSettings {
  const list = collapsedList(view);
  const k = idKey(id);
  const has = list.some((c) => idKey(c) === k);
  if (collapsed === has) return view;
  return {
    ...view,
    collapsedTaskIds: collapsed ? [...list, id] : list.filter((c) => idKey(c) !== k),
  };
}

export function toggleCollapsed(view: ViewSettings, id: string): ViewSettings {
  const k = idKey(id);
  const has = collapsedList(view).some((c) => idKey(c) === k);
  return setCollapsed(view, id, !has);
}

export function expandAll(view: ViewSettings): ViewSettings {
  if (collapsedList(view).length === 0) return view;
  return { ...view, collapsedTaskIds: [] };
}

export function collapseAll(view: ViewSettings, ix: TreeIndex): ViewSettings {
  const parents = displayOrder(ix).filter((id) => isParent(ix, id));
  return { ...view, collapsedTaskIds: parents };
}

/** Removes every ancestor of id from the collapsed list. */
export function revealTask(view: ViewSettings, ix: TreeIndex, id: string): ViewSettings {
  const anc = new Set(getAncestors(ix, id).map(idKey));
  const list = collapsedList(view);
  if (!list.some((c) => anc.has(idKey(c)))) return view;
  return { ...view, collapsedTaskIds: list.filter((c) => !anc.has(idKey(c))) };
}
