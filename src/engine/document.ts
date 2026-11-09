import { isValidIsoDate } from "../model/date";
import { idKey } from "../model/id";
import type { GanttDocument, Task } from "../model/types";
import { compileCalendar } from "./calendar";
import {
  buildTreeIndex,
  displayOrder,
  getAncestors,
  getChildren,
  isParent,
  type TreeIndex,
} from "./hierarchy";
import { findCyclicDependencies, findViolations } from "./scheduling";

export interface LoadIssue {
  code: string;
  /** JSON Pointer into the raw document */
  path: string;
  params?: Record<string, string | number>;
}

export type LoadResult =
  | { ok: true; doc: GanttDocument; warnings: LoadIssue[] }
  | { ok: false; errors: LoadIssue[] };

const DERIVED_KEYS = ["start", "end", "progress", "hours"] as const;

function checkDuplicateIds(
  list: ReadonlyArray<{ id: string }> | undefined,
  base: string,
  errors: LoadIssue[],
): boolean {
  const seen = new Set<string>();
  let dup = false;
  (list ?? []).forEach((x, i) => {
    const k = idKey(x.id);
    if (seen.has(k)) {
      dup = true;
      errors.push({ code: "DUPLICATE_ID", path: `/${base}/${i}/id` });
    }
    seen.add(k);
  });
  return dup;
}

/** Pre-order task array: roots and siblings keep their relative order in `tasks`. */
function sortPreOrder(ix: TreeIndex): Task[] {
  return displayOrder(ix).map((id) => ix.byId.get(idKey(id))!);
}

export function loadDocument(raw: GanttDocument): LoadResult {
  const errors: LoadIssue[] = [];
  const rawTasks = raw.tasks;

  // I1
  const dupTasks = checkDuplicateIds(rawTasks, "tasks", errors);
  checkDuplicateIds(raw.resources, "resources", errors);
  checkDuplicateIds(raw.colorLabels, "colorLabels", errors);

  // Index of the first task with a given id (raw index), used for paths.
  const rawIndex = new Map<string, number>();
  rawTasks.forEach((t, i) => {
    if (!rawIndex.has(idKey(t.id))) rawIndex.set(idKey(t.id), i);
  });

  // I2
  let parentMissing = false;
  rawTasks.forEach((t, i) => {
    if (t.parentId != null && !rawIndex.has(idKey(t.parentId))) {
      parentMissing = true;
      errors.push({ code: "PARENT_NOT_FOUND", path: `/tasks/${i}/parentId` });
    }
  });

  // I3: follow parent links; a task on a cycle is reported once.
  let parentCycle = false;
  const state = new Map<number, 0 | 1 | 2>(); // 1 = on current walk, 2 = done
  rawTasks.forEach((_, start) => {
    if (state.get(start)) return;
    const walk: number[] = [];
    let cur: number | undefined = start;
    while (cur !== undefined && !state.get(cur)) {
      state.set(cur, 1);
      walk.push(cur);
      const p: string | null | undefined = rawTasks[cur]!.parentId;
      cur = p == null ? undefined : rawIndex.get(idKey(p));
    }
    if (cur !== undefined && state.get(cur) === 1) {
      parentCycle = true;
      const from = walk.indexOf(cur);
      for (const i of walk.slice(from)) errors.push({ code: "PARENT_CYCLE", path: `/tasks/${i}/parentId` });
    }
    for (const i of walk) state.set(i, 2);
  });
  if (parentCycle) return { ok: false, errors };

  // I4, I5
  rawTasks.forEach((t, i) => {
    const seen = new Set<string>();
    (t.dependencies ?? []).forEach((dep, j) => {
      const path = `/tasks/${i}/dependencies/${j}/predecessorId`;
      const k = idKey(dep.predecessorId);
      if (k === idKey(t.id)) errors.push({ code: "DEPENDENCY_SELF", path });
      else if (!rawIndex.has(k)) errors.push({ code: "DEPENDENCY_NOT_FOUND", path });
      else if (seen.has(k)) errors.push({ code: "DEPENDENCY_DUPLICATE", path });
      seen.add(k);
    });
  });

  // Leaf determination on the raw data (needs no valid parent links beyond I2).
  const hasChild = new Set<string>();
  for (const t of rawTasks) if (t.parentId != null) hasChild.add(idKey(t.parentId));

  // I8
  rawTasks.forEach((t, i) => {
    if (hasChild.has(idKey(t.id))) return;
    if (t.start === undefined && t.end === undefined) {
      errors.push({ code: "LEAF_NO_DATES", path: `/tasks/${i}` });
    } else if (t.start !== undefined && t.end !== undefined && t.start > t.end) {
      errors.push({ code: "START_AFTER_END", path: `/tasks/${i}/end` });
    }
  });

  // I6, I7 need an unambiguous tree.
  if (!dupTasks && !parentMissing) {
    const ix = buildTreeIndex(raw);
    rawTasks.forEach((t, i) => {
      (t.dependencies ?? []).forEach((dep, j) => {
        const k = idKey(dep.predecessorId);
        if (k === idKey(t.id) || !rawIndex.has(k)) return;
        const anc = getAncestors(ix, t.id).some((a) => idKey(a) === k);
        const desc = getAncestors(ix, dep.predecessorId).some((a) => idKey(a) === idKey(t.id));
        if (anc || desc) errors.push({ code: "DEPENDENCY_ANCESTOR", path: `/tasks/${i}/dependencies/${j}` });
      });
    });
    const cyclic = new Set(findCyclicDependencies(raw).map((c) => `${idKey(c.succId)}|${idKey(c.predId)}`));
    if (cyclic.size > 0) {
      rawTasks.forEach((t, i) => {
        (t.dependencies ?? []).forEach((dep, j) => {
          if (cyclic.has(`${idKey(t.id)}|${idKey(dep.predecessorId)}`)) {
            errors.push({ code: "DEPENDENCY_CYCLE", path: `/tasks/${i}/dependencies/${j}` });
          }
        });
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- Normalization (01 section 4.2) ----
  const warnings: LoadIssue[] = [];
  const work = structuredClone(raw) as GanttDocument;
  work.resources ??= [];
  work.colorLabels ??= [];
  const resourceKeys = new Set(work.resources.map((r) => idKey(r.id)));
  const labelKeys = new Set(work.colorLabels.map((c) => idKey(c.id)));
  const ix0 = buildTreeIndex(work);
  const rawIdx = new Map<string, number>();
  work.tasks.forEach((t, i) => rawIdx.set(idKey(t.id), i));

  work.tasks.forEach((t, i) => {
    t.parentId ??= null;
    t.resourceIds ??= [];
    t.dependencies ??= [];
    if (isParent(ix0, t.id)) {
      let count = 0;
      for (const key of DERIVED_KEYS) {
        if (key in t) {
          delete t[key];
          count++;
        }
      }
      if (count > 0) {
        warnings.push({ code: "PARENT_DERIVED_IGNORED", path: `/tasks/${i}`, params: { count } });
      }
    } else {
      t.progress ??= 0;
      if (t.start === undefined) t.start = t.end;
      if (t.end === undefined) t.end = t.start;
    }
    t.resourceIds.forEach((r, j) => {
      if (!resourceKeys.has(idKey(r))) {
        warnings.push({ code: "UNKNOWN_RESOURCE", path: `/tasks/${i}/resourceIds/${j}` });
      }
    });
    if (t.colorLabelId !== undefined && !labelKeys.has(idKey(t.colorLabelId))) {
      warnings.push({ code: "UNKNOWN_COLOR_LABEL", path: `/tasks/${i}/colorLabelId` });
    }
  });

  work.tasks = sortPreOrder(ix0);
  work.view ??= { zoom: "day", collapsedTaskIds: [] };
  work.view.zoom ??= "day";
  work.view.collapsedTaskIds ??= [];

  // I12
  const wc = compileCalendar(work.project.calendar);
  for (const v of findViolations(work, wc)) {
    const i = rawIdx.get(idKey(v.succId))!;
    const j = (work.tasks.find((t) => idKey(t.id) === idKey(v.succId))?.dependencies ?? []).findIndex(
      (d) => idKey(d.predecessorId) === idKey(v.predId),
    );
    warnings.push({
      code: "DEPENDENCY_VIOLATION",
      path: `/tasks/${i}/dependencies/${j}`,
      params: { earliest: v.earliest, actualStart: v.actualStart },
    });
  }

  return { ok: true, doc: work, warnings };
}

/** Returns a copy normalized for writing (01 section 5.2). The input is not modified. */
export function prepareForSave(doc: GanttDocument): GanttDocument {
  const out = structuredClone(doc) as GanttDocument;
  const ix = buildTreeIndex(out);
  const order = displayOrder(ix);
  out.tasks = order.map((id) => ix.byId.get(idKey(id))!);
  for (const t of out.tasks) {
    if (isParent(ix, t.id)) for (const k of DERIVED_KEYS) delete t[k];
    if (t.notes === "") delete t.notes;
  }
  if (out.project.description === "") delete out.project.description;
  if (out.project.calendar) {
    out.project.calendar.holidays = [...new Set(out.project.calendar.holidays)]
      .filter((h) => isValidIsoDate(h))
      .sort();
  }
  out.view ??= { zoom: "day", collapsedTaskIds: [] };
  {
    const collapsed = new Set((out.view.collapsedTaskIds ?? []).map(idKey));
    out.view.zoom ??= "day";
    out.view.collapsedTaskIds = order.filter(
      (id) => collapsed.has(idKey(id)) && getChildren(ix, id).length > 0,
    );
  }
  return out;
}

export function createEmptyDocument(ctx: { projectName: string }): GanttDocument {
  return {
    version: 1,
    project: { name: ctx.projectName },
    resources: [],
    colorLabels: [],
    tasks: [],
    view: { zoom: "day", collapsedTaskIds: [] },
  };
}
