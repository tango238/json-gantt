import { addDays } from "../model/date";
import { idKey } from "../model/id";
import type { Dependency, GanttDocument, IsoDate, Task } from "../model/types";
import {
  addWorkingDays,
  durationOf,
  nextWorkingDay,
  workingDayOffset,
  type WorkCalendar,
} from "./calendar";
import type { EngineErrorCode } from "./errors";
import { SchedulingError } from "./errors";
import {
  buildTreeIndex,
  effectiveEnd,
  effectiveStart,
  getAncestors,
  getChildren,
  getLeafDescendantsOrSelf,
  type TreeIndex,
} from "./hierarchy";

// ---------------------------------------------------------------------------
// FS constraint (02 section 3.1)
// ---------------------------------------------------------------------------

export function earliestFrom(ix: TreeIndex, wc: WorkCalendar, predId: string, dep: Dependency): IsoDate {
  return nextWorkingDay(addDays(effectiveEnd(ix, predId), 1 + (dep.lag ?? 0)), wc);
}

/** Max earliestFrom over the dependencies of taskId and all its ancestors; null if none. */
export function earliestStartFor(
  _doc: GanttDocument,
  ix: TreeIndex,
  wc: WorkCalendar,
  taskId: string,
): IsoDate | null {
  let best: IsoDate | null = null;
  for (const n of [taskId, ...getAncestors(ix, taskId)]) {
    const t = ix.byId.get(idKey(n));
    if (!t || !t.dependencies) continue;
    for (const dep of t.dependencies) {
      if (!ix.byId.has(idKey(dep.predecessorId))) continue;
      const e = earliestFrom(ix, wc, dep.predecessorId, dep);
      if (best === null || e > best) best = e;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Push primitives (02 section 3.2)
// ---------------------------------------------------------------------------

export function shiftLeafTo(leaf: Task, target: IsoDate, wc: WorkCalendar): void {
  const d = Math.max(1, durationOf(leaf.start!, leaf.end!, wc));
  const s = nextWorkingDay(target, wc);
  leaf.start = s;
  leaf.end = addWorkingDays(s, d - 1, wc);
}

/**
 * Shifts all leaves under `parentId` by the same number of working days (k >= 0; leaves are also
 * snapped to working days). Returns only the leaves whose dates actually changed.
 */
export function shiftGroupTo(ix: TreeIndex, wc: WorkCalendar, parentId: string, target: IsoDate): string[] {
  const ps = nextWorkingDay(effectiveStart(ix, parentId), wc);
  const k = Math.max(0, workingDayOffset(ps, nextWorkingDay(target, wc), wc));
  const changed: string[] = [];
  for (const l of getLeafDescendantsOrSelf(ix, parentId)) {
    const leaf = ix.byId.get(idKey(l))!;
    const oldStart = leaf.start;
    const oldEnd = leaf.end;
    shiftLeafTo(leaf, addWorkingDays(nextWorkingDay(leaf.start!, wc), k, wc), wc);
    if (leaf.start !== oldStart || leaf.end !== oldEnd) changed.push(l);
  }
  return changed;
}

/** Returns the leaves that moved (empty when the constraint already holds). */
export function pushIfViolated(ix: TreeIndex, wc: WorkCalendar, succId: string, earliest: IsoDate): string[] {
  if (effectiveStart(ix, succId) >= earliest) return [];
  if (getChildren(ix, succId).length === 0) {
    shiftLeafTo(ix.byId.get(idKey(succId))!, earliest, wc);
    return [succId];
  }
  return shiftGroupTo(ix, wc, succId, earliest);
}

function scheduleLimit(doc: GanttDocument): number {
  let deps = 0;
  for (const t of doc.tasks) deps += t.dependencies?.length ?? 0;
  return 50 * (doc.tasks.length + deps + 1);
}

// ---------------------------------------------------------------------------
// Propagation (02 section 3.3)
// ---------------------------------------------------------------------------

type Outgoing = Map<string, Array<{ succId: string; dep: Dependency }>>;

function buildOutgoing(doc: GanttDocument): Outgoing {
  const outgoing: Outgoing = new Map();
  for (const t of doc.tasks) {
    for (const dep of t.dependencies ?? []) {
      const k = idKey(dep.predecessorId);
      let list = outgoing.get(k);
      if (!list) {
        list = [];
        outgoing.set(k, list);
      }
      list.push({ succId: t.id, dep });
    }
  }
  return outgoing;
}

export function schedule(
  draft: GanttDocument,
  wc: WorkCalendar,
  seeds: readonly string[],
  opts: { clampSeeds: boolean },
): void {
  const ix = buildTreeIndex(draft);
  const outgoing = buildOutgoing(draft);
  if (opts.clampSeeds) {
    for (const l of seeds) {
      const leaf = ix.byId.get(idKey(l));
      if (!leaf) continue;
      const es = earliestStartFor(draft, ix, wc, l);
      if (es !== null && leaf.start! < es) shiftLeafTo(leaf, es, wc);
    }
  }
  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (id: string): void => {
    const k = idKey(id);
    if (queued.has(k)) return;
    queued.add(k);
    queue.push(id);
  };
  for (const s of seeds) enqueue(s);

  const limit = scheduleLimit(draft);
  let steps = 0;
  let head = 0;
  // Queue items are leaves (moved tasks) or ancestors of moved leaves. An ancestor is queued once
  // per round of changes, so its (subtree-wide) end is evaluated once instead of once per leaf.
  while (head < queue.length) {
    if (++steps > limit) throw new SchedulingError();
    const n = queue[head++]!;
    queued.delete(idKey(n));
    const outs = outgoing.get(idKey(n));
    if (outs) {
      for (const { succId, dep } of outs) {
        const moved = pushIfViolated(ix, wc, succId, earliestFrom(ix, wc, n, dep));
        for (const m of moved) enqueue(m);
      }
    }
    if (getChildren(ix, n).length === 0) {
      for (const a of getAncestors(ix, n)) enqueue(a);
    }
  }
}

// ---------------------------------------------------------------------------
// Full reschedule and violations (02 sections 3.5, 3.6)
// ---------------------------------------------------------------------------

export function rescheduleAll(draft: GanttDocument, wc: WorkCalendar): void {
  const ix = buildTreeIndex(draft);
  const g = buildSEGraph(draft, ix, false);
  const outgoing = buildOutgoing(draft);
  const n = g.adj.length;
  // Kahn topological order over the S/E graph. Each constraint is applied once, when the
  // predecessor's end (E node) is final; a cycle leaves nodes unprocessed.
  const indeg = new Int32Array(n);
  for (const edges of g.adj) for (const v of edges) indeg[v]!++;
  const stack: number[] = [];
  for (let u = 0; u < n; u++) if (indeg[u] === 0) stack.push(u);
  let processed = 0;
  while (stack.length > 0) {
    const u = stack.pop()!;
    processed++;
    if (u & 1) {
      const predId = g.taskIds[u >> 1]!;
      for (const { succId, dep } of outgoing.get(idKey(predId)) ?? []) {
        pushIfViolated(ix, wc, succId, earliestFrom(ix, wc, predId, dep));
      }
    }
    for (const v of g.adj[u]!) if (--indeg[v]! === 0) stack.push(v);
  }
  if (processed < n) throw new SchedulingError();
}

export interface Violation {
  succId: string;
  predId: string;
  earliest: IsoDate;
  actualStart: IsoDate;
}

export function findViolations(doc: GanttDocument, wc: WorkCalendar): Violation[] {
  const ix = buildTreeIndex(doc);
  const out: Violation[] = [];
  for (const t of doc.tasks) {
    for (const dep of t.dependencies ?? []) {
      if (!ix.byId.has(idKey(dep.predecessorId))) continue;
      const earliest = earliestFrom(ix, wc, dep.predecessorId, dep);
      const actualStart = effectiveStart(ix, t.id);
      if (actualStart < earliest) {
        out.push({ succId: t.id, predId: dep.predecessorId, earliest, actualStart });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cycle detection on the S/E graph (02 section 3.4)
// ---------------------------------------------------------------------------

interface SEGraph {
  adj: number[][];
  taskIds: string[]; // node n belongs to taskIds[n >> 1]
  nodeOf: Map<string, number>; // idKey -> task index
}

const S = (i: number): number => 2 * i;
const E = (i: number): number => 2 * i + 1;

function buildSEGraph(doc: GanttDocument, ix: TreeIndex, skipAncestorDeps: boolean): SEGraph {
  const nodeOf = new Map<string, number>();
  const taskIds: string[] = [];
  for (const t of doc.tasks) {
    const k = idKey(t.id);
    if (nodeOf.has(k)) continue;
    nodeOf.set(k, taskIds.length);
    taskIds.push(t.id);
  }
  const adj: number[][] = Array.from({ length: taskIds.length * 2 }, () => []);
  for (let i = 0; i < taskIds.length; i++) {
    const kids = getChildren(ix, taskIds[i]!);
    if (kids.length === 0) {
      adj[S(i)]!.push(E(i));
    } else {
      for (const c of kids) {
        const ci = nodeOf.get(idKey(c));
        if (ci === undefined) continue;
        adj[S(i)]!.push(S(ci));
        adj[E(ci)]!.push(E(i));
      }
    }
  }
  for (const t of doc.tasks) {
    const si = nodeOf.get(idKey(t.id))!;
    for (const dep of t.dependencies ?? []) {
      const pi = nodeOf.get(idKey(dep.predecessorId));
      if (pi === undefined || pi === si) continue;
      if (skipAncestorDeps && isAncestorOrDescendant(ix, t.id, dep.predecessorId)) continue;
      adj[E(pi)]!.push(S(si));
    }
  }
  return { adj, taskIds, nodeOf };
}

function isAncestorOrDescendant(ix: TreeIndex, a: string, b: string): boolean {
  const kb = idKey(b);
  const ka = idKey(a);
  return getAncestors(ix, a).some((x) => idKey(x) === kb) || getAncestors(ix, b).some((x) => idKey(x) === ka);
}

function findCycleNodes(adj: number[][]): number[] | null {
  const n = adj.length;
  const color = new Uint8Array(n); // 0 white, 1 gray, 2 black
  const iter = new Int32Array(n);
  for (let root = 0; root < n; root++) {
    if (color[root] !== 0) continue;
    const stack: number[] = [root];
    color[root] = 1;
    while (stack.length > 0) {
      const u = stack[stack.length - 1]!;
      const edges = adj[u]!;
      if (iter[u]! < edges.length) {
        const v = edges[iter[u]!++]!;
        if (color[v] === 0) {
          color[v] = 1;
          stack.push(v);
        } else if (color[v] === 1) {
          return stack.slice(stack.indexOf(v));
        }
      } else {
        color[u] = 2;
        stack.pop();
      }
    }
  }
  return null;
}

/** Task ids on a cycle of the S/E graph (deduplicated, in order of appearance), or null. */
export function findDependencyCycle(doc: GanttDocument): string[] | null {
  return findCycleOnGraph(doc, buildSEGraph(doc, buildTreeIndex(doc), false));
}

function findCycleOnGraph(_doc: GanttDocument, g: SEGraph): string[] | null {
  const cyc = findCycleNodes(g.adj);
  if (!cyc) return null;
  const seen = new Set<number>();
  const ids: string[] = [];
  for (const node of cyc) {
    const ti = node >> 1;
    if (seen.has(ti)) continue;
    seen.add(ti);
    ids.push(g.taskIds[ti]!);
  }
  return ids;
}

export type CanAddDependency =
  | { ok: true }
  | {
      ok: false;
      code:
        | "TASK_NOT_FOUND"
        | "DEPENDENCY_SELF"
        | "DEPENDENCY_DUPLICATE"
        | "DEPENDENCY_ANCESTOR"
        | "DEPENDENCY_CYCLE";
    };

export function canAddDependency(doc: GanttDocument, succId: string, predId: string): CanAddDependency {
  const ix = buildTreeIndex(doc);
  const succ = ix.byId.get(idKey(succId));
  if (!succ || !ix.byId.has(idKey(predId))) return { ok: false, code: "TASK_NOT_FOUND" };
  if (idKey(succId) === idKey(predId)) return { ok: false, code: "DEPENDENCY_SELF" };
  if ((succ.dependencies ?? []).some((d) => idKey(d.predecessorId) === idKey(predId))) {
    return { ok: false, code: "DEPENDENCY_DUPLICATE" };
  }
  if (isAncestorOrDescendant(ix, succId, predId)) return { ok: false, code: "DEPENDENCY_ANCESTOR" };

  // Adding E(pred) -> S(succ) closes a cycle iff S(succ) already reaches E(pred).
  const g = buildSEGraph(doc, ix, false);
  const from = S(g.nodeOf.get(idKey(succId))!);
  const target = E(g.nodeOf.get(idKey(predId))!);
  const seen = new Uint8Array(g.adj.length);
  const stack = [from];
  seen[from] = 1;
  while (stack.length > 0) {
    const u = stack.pop()!;
    if (u === target) return { ok: false, code: "DEPENDENCY_CYCLE" };
    for (const v of g.adj[u]!) {
      if (!seen[v]) {
        seen[v] = 1;
        stack.push(v);
      }
    }
  }
  return { ok: true };
}

export interface StructureIssue {
  code: Extract<EngineErrorCode, "DEPENDENCY_ANCESTOR" | "DEPENDENCY_CYCLE">;
  taskIds: string[];
}

/** I6 (ancestor/descendant dependencies) and I7 (S/E cycle). Ancestor dependencies are not re-reported as cycles. */
export function validateStructure(doc: GanttDocument): StructureIssue[] {
  const ix = buildTreeIndex(doc);
  const issues: StructureIssue[] = [];
  for (const t of doc.tasks) {
    for (const dep of t.dependencies ?? []) {
      if (!ix.byId.has(idKey(dep.predecessorId))) continue;
      if (idKey(dep.predecessorId) === idKey(t.id)) continue;
      if (isAncestorOrDescendant(ix, t.id, dep.predecessorId)) {
        issues.push({ code: "DEPENDENCY_ANCESTOR", taskIds: [t.id, dep.predecessorId] });
      }
    }
  }
  const cycle = findCycleOnGraph(doc, buildSEGraph(doc, ix, true));
  if (cycle) issues.push({ code: "DEPENDENCY_CYCLE", taskIds: cycle });
  return issues;
}

/**
 * Dependencies that lie on a cycle of the S/E graph (both ends in the same strongly connected
 * component). Reports every independent cycle, not only the first. Ancestor/descendant
 * dependencies are excluded (they are reported as DEPENDENCY_ANCESTOR).
 */
export function findCyclicDependencies(doc: GanttDocument): Array<{ succId: string; predId: string }> {
  const ix = buildTreeIndex(doc);
  const g = buildSEGraph(doc, ix, true);
  const n = g.adj.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const comp = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const iter = new Int32Array(n);
  const compSize: number[] = [];
  const tarjan: number[] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const call: number[] = [root];
    index[root] = low[root] = counter++;
    tarjan.push(root);
    onStack[root] = 1;
    while (call.length > 0) {
      const u = call[call.length - 1]!;
      const edges = g.adj[u]!;
      if (iter[u]! < edges.length) {
        const v = edges[iter[u]!++]!;
        if (index[v] === -1) {
          index[v] = low[v] = counter++;
          tarjan.push(v);
          onStack[v] = 1;
          call.push(v);
        } else if (onStack[v]) {
          low[u] = Math.min(low[u]!, index[v]!);
        }
      } else {
        call.pop();
        if (call.length > 0) {
          const parent = call[call.length - 1]!;
          low[parent] = Math.min(low[parent]!, low[u]!);
        }
        if (low[u] === index[u]) {
          const id = compSize.length;
          let size = 0;
          let w: number;
          do {
            w = tarjan.pop()!;
            onStack[w] = 0;
            comp[w] = id;
            size++;
          } while (w !== u);
          compSize.push(size);
        }
      }
    }
  }
  const out: Array<{ succId: string; predId: string }> = [];
  for (const t of doc.tasks) {
    const si = g.nodeOf.get(idKey(t.id));
    for (const dep of t.dependencies ?? []) {
      const pi = g.nodeOf.get(idKey(dep.predecessorId));
      if (si === undefined || pi === undefined || pi === si) continue;
      if (isAncestorOrDescendant(ix, t.id, dep.predecessorId)) continue;
      const c = comp[E(pi)]!;
      if (c === comp[S(si)] && compSize[c]! >= 2) out.push({ succId: t.id, predId: dep.predecessorId });
    }
  }
  return out;
}
