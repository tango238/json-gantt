import type { Dependency, GanttDocument, Task } from "../../model/types";
import { compileCalendar } from "../calendar";

export const WC5 = compileCalendar({ weekends: [0, 6], holidays: [] });
export const WC0 = compileCalendar(undefined);

export function seq(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export interface TestContext {
  today: string;
  newId: () => string;
  defaultTaskName: string;
}

export function makeCtx(today = "2023-05-22"): TestContext {
  return { today, newId: seq("N"), defaultTaskName: "新しいタスク" };
}
export const ctx: TestContext = makeCtx();

export interface TaskSpec {
  id: string;
  parentId?: string | null;
  start?: string;
  end?: string;
  progress?: number;
  hours?: number;
  /** predecessor ids (FS, no lag) */
  deps?: string[];
  lagDeps?: Dependency[];
  resourceIds?: string[];
  name?: string;
}

/** Leaf: pass start (end defaults to start). Parent: omit dates. */
export function task(spec: TaskSpec): Task {
  const t: Task = {
    id: spec.id,
    parentId: spec.parentId ?? null,
    name: spec.name ?? spec.id,
    resourceIds: spec.resourceIds ?? [],
    dependencies: [
      ...(spec.deps ?? []).map((p) => ({ predecessorId: p })),
      ...(spec.lagDeps ?? []),
    ],
  };
  if (spec.start !== undefined) {
    t.start = spec.start;
    t.end = spec.end ?? spec.start;
    t.progress = spec.progress ?? 0;
  }
  if (spec.hours !== undefined) t.hours = spec.hours;
  return t;
}

export function doc(tasks: Task[], opts: { calendar?: boolean } = {}): GanttDocument {
  const withCal = opts.calendar ?? true;
  return {
    version: 1,
    project: {
      name: "T",
      ...(withCal ? { calendar: { weekends: [0, 6], holidays: [] } } : {}),
    },
    resources: [],
    colorLabels: [],
    tasks,
    view: { zoom: "day", collapsedTaskIds: [] },
  };
}

export function byId(d: GanttDocument, id: string): Task {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

export function span(d: GanttDocument, id: string): [string | undefined, string | undefined] {
  const t = byId(d, id);
  return [t.start, t.end];
}
