import { compileCalendar, deepEqual, findViolations } from "../engine";
import { t as translate, type Params } from "../i18n";
import { idKey } from "../model/id";
import type { GanttDocument } from "../model/types";

export interface CountDiff {
  added: number;
  removed: number;
  changed: number;
}

export interface ChangeSummary {
  tasksAdded: number;
  tasksRemoved: number;
  tasksChanged: number;
  /** Same tasks, but their relative order changed. */
  tasksReordered: boolean;
  /** project (name / description / calendar / unknown keys) changed. */
  project: boolean;
  /** project.calendar changed (breakdown of `project`). */
  calendar: boolean;
  /** project changed in something other than the calendar. */
  projectInfo: boolean;
  resources: CountDiff;
  colorLabels: CountDiff;
  /** Other top-level keys (unknown fields etc.; `view` excluded). */
  other: boolean;
  /** Dependency violations in `after`. */
  violations: number;
  addedTaskIds: string[];
  changedTaskIds: string[];
}

const KNOWN_KEYS = new Set(["project", "resources", "colorLabels", "tasks", "view"]);

function diffById<T extends { id: string }>(
  before: readonly T[] | undefined,
  after: readonly T[] | undefined,
): CountDiff & { addedIds: string[]; changedIds: string[]; reordered: boolean } {
  const b = new Map((before ?? []).map((x) => [idKey(x.id), x] as const));
  const a = new Map((after ?? []).map((x) => [idKey(x.id), x] as const));
  const addedIds: string[] = [];
  const changedIds: string[] = [];
  let removed = 0;
  for (const [k, x] of a) {
    const old = b.get(k);
    if (old === undefined) addedIds.push(x.id);
    else if (!deepEqual(old, x)) changedIds.push(x.id);
  }
  for (const k of b.keys()) if (!a.has(k)) removed++;
  const orderB = [...b.keys()].filter((k) => a.has(k));
  const orderA = [...a.keys()].filter((k) => b.has(k));
  return {
    added: addedIds.length,
    removed,
    changed: changedIds.length,
    addedIds,
    changedIds,
    reordered: orderA.some((k, i) => k !== orderB[i]),
  };
}

export function summarizeChanges(before: GanttDocument, after: GanttDocument): ChangeSummary {
  const tasks = diffById(before.tasks, after.tasks);
  const resources = diffById(before.resources, after.resources);
  const colorLabels = diffById(before.colorLabels, after.colorLabels);

  const calendar = !deepEqual(before.project.calendar, after.project.calendar);
  const { calendar: _c1, ...pb } = before.project;
  const { calendar: _c2, ...pa } = after.project;
  const projectInfo = !deepEqual(pb, pa);

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const other = [...keys].some((k) => !KNOWN_KEYS.has(k) && !deepEqual(before[k], after[k]));

  return {
    tasksAdded: tasks.added,
    tasksRemoved: tasks.removed,
    tasksChanged: tasks.changed,
    tasksReordered: tasks.reordered,
    project: calendar || projectInfo,
    calendar,
    projectInfo,
    resources: { added: resources.added, removed: resources.removed, changed: resources.changed },
    colorLabels: { added: colorLabels.added, removed: colorLabels.removed, changed: colorLabels.changed },
    other,
    violations: findViolations(after, compileCalendar(after.project.calendar)).length,
    addedTaskIds: tasks.addedIds,
    changedTaskIds: tasks.changedIds,
  };
}

export type Translate = (key: string, params?: Params) => string;

/**
 * One line such as "1 task added, 3 tasks changed" via i18n keys `ai.summary.*`. Zero items are omitted.
 * `tr` is injectable for tests.
 */
export function formatSummary(s: ChangeSummary, tr: Translate = translate): string {
  const parts: string[] = [];
  const count = (key: string, n: number) => {
    if (n > 0) parts.push(tr(`ai.summary.${key}`, { count: n }));
  };
  count("tasksAdded", s.tasksAdded);
  count("tasksRemoved", s.tasksRemoved);
  count("tasksChanged", s.tasksChanged);
  if (s.tasksReordered) parts.push(tr("ai.summary.tasksReordered"));
  if (s.projectInfo || (s.project && !s.calendar)) parts.push(tr("ai.summary.project"));
  if (s.calendar) parts.push(tr("ai.summary.calendar"));
  count("resourcesAdded", s.resources.added);
  count("resourcesRemoved", s.resources.removed);
  count("resourcesChanged", s.resources.changed);
  count("colorLabelsAdded", s.colorLabels.added);
  count("colorLabelsRemoved", s.colorLabels.removed);
  count("colorLabelsChanged", s.colorLabels.changed);
  if (s.other) parts.push(tr("ai.summary.other"));
  if (parts.length === 0) parts.push(tr("ai.summary.none"));
  let text = parts.join(tr("ai.summary.separator"));
  if (s.violations > 0) text += tr("ai.summary.violations", { count: s.violations });
  return text;
}
