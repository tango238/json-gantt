import { describe, expect, it } from "vitest";
import { executeCommand, type Command, type CommandOk } from "../commands";
import { SchedulingError } from "../errors";
import { buildTreeIndex } from "../hierarchy";
import {
  canAddDependency,
  earliestStartFor,
  findDependencyCycle,
  findViolations,
  rescheduleAll,
  schedule,
  validateStructure,
} from "../scheduling";
import type { GanttDocument } from "../../model/types";
import { produce } from "immer";
import { WC5, doc, makeCtx, span, task } from "./fixtures";

function run(d: GanttDocument, cmd: Command): CommandOk {
  const r = executeCommand(d, cmd, makeCtx());
  if (!r.ok) throw new Error(`unexpected error ${r.code}`);
  return r;
}

describe("scheduling", () => {
  it("S1: moving a predecessor pushes the successor", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24", end: "2023-05-25", deps: ["A"] }),
    ]);
    const r = run(d, { type: "moveTask", id: "A", deltaDays: 1 });
    expect(span(r.doc, "A")).toEqual(["2023-05-23", "2023-05-24"]);
    expect(span(r.doc, "B")).toEqual(["2023-05-25", "2023-05-26"]);
  });

  it("S2: pushed successors skip weekends", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-24", end: "2023-05-25" }),
      task({ id: "B", start: "2023-05-26", deps: ["A"] }),
    ]);
    const r = run(d, { type: "resizeTaskEnd", id: "A", newEnd: "2023-05-26" });
    expect(span(r.doc, "B")).toEqual(["2023-05-29", "2023-05-29"]);
  });

  it("S3: propagates transitively", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
      task({ id: "C", start: "2023-05-24", deps: ["B"] }),
    ]);
    const r = run(d, { type: "moveTask", id: "A", deltaDays: 2 });
    expect(span(r.doc, "A")[0]).toBe("2023-05-24");
    expect(span(r.doc, "B")[0]).toBe("2023-05-25");
    expect(span(r.doc, "C")[0]).toBe("2023-05-26");
  });

  it("S4: never pulls successors earlier", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24", deps: ["A"] }),
    ]);
    const r = run(d, { type: "moveTask", id: "A", deltaDays: -1 });
    expect(span(r.doc, "A")[0]).toBe("2023-05-22");
    expect(span(r.doc, "B")[0]).toBe("2023-05-24");
  });

  it("S5: addDependency honours lag (calendar days)", () => {
    const d = doc([task({ id: "A", start: "2023-05-23" }), task({ id: "B", start: "2023-05-24" })]);
    const r2 = run(d, { type: "addDependency", succId: "B", predId: "A", lag: 2 });
    expect(span(r2.doc, "B")).toEqual(["2023-05-26", "2023-05-26"]);
    expect(r2.doc.tasks[1]!.dependencies).toEqual([{ predecessorId: "A", lag: 2 }]);
    const r3 = run(d, { type: "addDependency", succId: "B", predId: "A", lag: 3 });
    expect(span(r3.doc, "B")[0]).toBe("2023-05-29");
    const r0 = run(d, { type: "addDependency", succId: "B", predId: "A", lag: 0 });
    expect(r0.doc.tasks[1]!.dependencies).toEqual([{ predecessorId: "A" }]);
  });

  it("S6: a parent predecessor uses the derived end", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", parentId: "P", start: "2023-05-22", end: "2023-05-24" }),
      task({ id: "X", start: "2023-05-25", deps: ["P"] }),
    ]);
    const r = run(d, { type: "resizeTaskEnd", id: "A", newEnd: "2023-05-25" });
    expect(span(r.doc, "X")).toEqual(["2023-05-26", "2023-05-26"]);
  });

  it("S7: a parent successor shifts its children as a group", () => {
    const d = doc([
      task({ id: "Q", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "P", deps: ["Q"] }),
      task({ id: "A", parentId: "P", start: "2023-05-24" }),
      task({ id: "B", parentId: "P", start: "2023-05-25", end: "2023-05-26" }),
    ]);
    const r = run(d, { type: "moveTask", id: "Q", deltaDays: 1 });
    expect(span(r.doc, "Q")).toEqual(["2023-05-23", "2023-05-24"]);
    expect(span(r.doc, "A")).toEqual(["2023-05-25", "2023-05-25"]);
    expect(span(r.doc, "B")).toEqual(["2023-05-26", "2023-05-29"]);
  });

  it("S8: moving a successor before its predecessor stops at the constraint (no patches)", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24", deps: ["A"] }),
    ]);
    const r = run(d, { type: "moveTask", id: "B", deltaDays: -2 });
    expect(span(r.doc, "B")).toEqual(["2023-05-24", "2023-05-24"]);
    expect(r.patches).toEqual([]);
    expect(r.doc).toBe(d);
  });

  it("S9: addDependency rejects a cycle", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
    ]);
    const r = executeCommand(d, { type: "addDependency", succId: "A", predId: "B" }, makeCtx());
    expect(r).toMatchObject({ ok: false, code: "DEPENDENCY_CYCLE" });
  });

  it("S10: addDependency rejects parent/child links", () => {
    const d = doc([task({ id: "P" }), task({ id: "A", parentId: "P", start: "2023-05-22" })]);
    expect(executeCommand(d, { type: "addDependency", succId: "A", predId: "P" }, makeCtx())).toMatchObject({
      ok: false,
      code: "DEPENDENCY_ANCESTOR",
    });
    expect(executeCommand(d, { type: "addDependency", succId: "P", predId: "A" }, makeCtx())).toMatchObject({
      ok: false,
      code: "DEPENDENCY_ANCESTOR",
    });
  });

  it("S11: cycle through a parent is rejected", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "C", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-25", deps: ["P"] }),
    ]);
    expect(executeCommand(d, { type: "addDependency", succId: "C", predId: "B" }, makeCtx())).toMatchObject({
      ok: false,
      code: "DEPENDENCY_CYCLE",
    });
  });

  it("S12: new dependency immediately pushes the successor", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-24" }),
      task({ id: "B", start: "2023-05-23" }),
    ]);
    const r = run(d, { type: "addDependency", succId: "B", predId: "A" });
    expect(span(r.doc, "B")).toEqual(["2023-05-25", "2023-05-25"]);
  });

  it("S13: touching a task fixes its pre-existing violating successors only", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-25" }),
      task({ id: "B", start: "2023-05-25", end: "2023-05-26", deps: ["A"] }),
    ]);
    const r = run(d, { type: "resizeTaskEnd", id: "A", newEnd: "2023-05-25" });
    expect(span(r.doc, "A")).toEqual(["2023-05-22", "2023-05-25"]);
    expect(span(r.doc, "B")).toEqual(["2023-05-26", "2023-05-29"]);
    expect(r.patches.every((p) => p.path[1] === 1)).toBe(true);
    expect(r.patches.length).toBeGreaterThan(0);
  });

  it("S14: without a calendar weekends are working days", () => {
    const d = doc(
      [task({ id: "A", start: "2023-05-26" }), task({ id: "B", start: "2023-05-27", deps: ["A"] })],
      { calendar: false },
    );
    const r = run(d, { type: "moveTask", id: "A", deltaDays: 1 });
    expect(span(r.doc, "A")[0]).toBe("2023-05-27");
    expect(span(r.doc, "B")[0]).toBe("2023-05-28");
  });

  const s15 = () =>
    doc([
      task({ id: "C", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "D", start: "2023-05-22", deps: ["C"] }),
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
    ]);

  it("S15: unrelated violations are left alone", () => {
    const r = run(s15(), { type: "moveTask", id: "A", deltaDays: 1 });
    expect(span(r.doc, "D")[0]).toBe("2023-05-22");
    expect(span(r.doc, "B")[0]).toBe("2023-05-24");
  });

  it("S16: rescheduleAll repairs every violation", () => {
    const r = run(s15(), { type: "rescheduleAll" });
    expect(span(r.doc, "D")[0]).toBe("2023-05-24");
    expect(findViolations(r.doc, WC5)).toEqual([]);
  });

  it("S17: findViolations", () => {
    expect(findViolations(s15(), WC5)).toEqual([
      { succId: "D", predId: "C", earliest: "2023-05-24", actualStart: "2023-05-22" },
    ]);
  });
});

describe("scheduling: extras", () => {
  it("S18: findDependencyCycle returns the cycle members", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", deps: ["B"] }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
      task({ id: "Z", start: "2023-05-23" }),
    ]);
    const c = findDependencyCycle(d)!;
    expect([...c].sort()).toEqual(["A", "B"]);
    expect(findDependencyCycle(doc([task({ id: "A", start: "2023-05-22" })]))).toBeNull();
  });

  it("S19: cycles through hierarchy (A->B, B->C, C child of A)", () => {
    const d = doc([
      task({ id: "A" }),
      task({ id: "C", parentId: "A", start: "2023-05-22", deps: ["B"] }),
      task({ id: "B", start: "2023-05-22", deps: ["A"] }),
    ]);
    const issues = validateStructure(d);
    expect(issues.map((i) => i.code)).toEqual(["DEPENDENCY_CYCLE"]);
    expect(new Set(issues[0]!.taskIds)).toEqual(new Set(["A", "B", "C"]));
  });

  it("S20: child depending on parent and parent on child are reported as ancestor links", () => {
    const d = doc([
      task({ id: "P", deps: ["c"] }),
      task({ id: "c", parentId: "P", start: "2023-05-22", deps: ["P"] }),
    ]);
    const issues = validateStructure(d);
    expect(issues.map((i) => i.code)).toEqual(["DEPENDENCY_ANCESTOR", "DEPENDENCY_ANCESTOR"]);
    expect(issues[0]!.taskIds).toEqual(["P", "c"]);
    expect(validateStructure(doc([task({ id: "A", start: "2023-05-22" })]))).toEqual([]);
  });

  it("S21: canAddDependency precondition order", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
    ]);
    expect(canAddDependency(d, "B", "nope")).toEqual({ ok: false, code: "TASK_NOT_FOUND" });
    expect(canAddDependency(d, "nope", "A")).toEqual({ ok: false, code: "TASK_NOT_FOUND" });
    expect(canAddDependency(d, "A", "A")).toEqual({ ok: false, code: "DEPENDENCY_SELF" });
    expect(canAddDependency(d, "B", "A")).toEqual({ ok: false, code: "DEPENDENCY_DUPLICATE" });
    expect(canAddDependency(d, "A", "B")).toEqual({ ok: false, code: "DEPENDENCY_CYCLE" });
    const d2 = doc([...d.tasks, task({ id: "C", start: "2023-05-24" })]);
    expect(canAddDependency(d2, "C", "A")).toEqual({ ok: true });
  });

  it("S22: earliestStartFor includes ancestors' dependencies", () => {
    const d = doc([
      task({ id: "X", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "P", deps: ["X"] }),
      task({ id: "c", parentId: "P", start: "2023-05-22" }),
    ]);
    const ix = buildTreeIndex(d);
    expect(earliestStartFor(d, ix, WC5, "c")).toBe("2023-05-24");
    expect(earliestStartFor(d, ix, WC5, "X")).toBeNull();
  });

  it("S23: a leaf moved before its parent's predecessor is clamped (rule B)", () => {
    const d = doc([
      task({ id: "X", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "P", deps: ["X"] }),
      task({ id: "c", parentId: "P", start: "2023-05-24", end: "2023-05-25" }),
    ]);
    const r = run(d, { type: "setDates", id: "c", start: "2023-05-22", end: "2023-05-23" });
    expect(span(r.doc, "c")).toEqual(["2023-05-24", "2023-05-25"]);
  });

  it("S24: lag moves/ignores dependencies whose predecessor is missing", () => {
    const d = doc([task({ id: "A", start: "2023-05-22", deps: ["ghost"] })]);
    expect(findViolations(d, WC5)).toEqual([]);
    expect(produce(d, (dr) => rescheduleAll(dr, WC5))).toBe(d);
    expect(earliestStartFor(d, buildTreeIndex(d), WC5, "A")).toBeNull();
  });

  it("S25: a parent whose derived start is a non-working day is pushed to the next working day", () => {
    const d = doc([
      task({ id: "X", start: "2023-05-26" }),
      task({ id: "P", deps: ["X"] }),
      task({ id: "c", parentId: "P", start: "2023-05-27", end: "2023-05-27" }),
    ]);
    expect(findViolations(d, WC5)).toHaveLength(1);
    const next = produce(d, (dr) => rescheduleAll(dr, WC5));
    expect(span(next, "c")).toEqual(["2023-05-29", "2023-05-29"]);
    expect(findViolations(next, WC5)).toEqual([]);
    // also via a command on the predecessor
    const r = run(d, { type: "resizeTaskEnd", id: "X", newEnd: "2023-05-26" });
    expect(span(r.doc, "c")[0]).toBe("2023-05-29");
  });

  it("S28: rescheduleAll on a 1000-task chain stored successor-first is fast", () => {
    const N = 1000;
    const tasks = [];
    // array order: T999 ... T0, each Ti depends on T(i-1); all start the same day -> every link violated
    for (let i = N - 1; i >= 0; i--) {
      tasks.push(task({ id: `T${i}`, start: "2023-05-22", deps: i > 0 ? [`T${i - 1}`] : [] }));
    }
    const d = doc(tasks);
    expect(findViolations(d, WC5)).toHaveLength(N - 1);
    const t0 = performance.now();
    const r = executeCommand(d, { type: "rescheduleAll" }, makeCtx());
    const elapsed = performance.now() - t0;
    console.log(`perf: reverse-ordered 1000 chain rescheduleAll took ${elapsed.toFixed(1)}ms`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(findViolations(r.doc, WC5)).toEqual([]);
    expect(elapsed).toBeLessThan(200);
  });

  it("S29: moving a parent with 2000 leaves that has a successor is fast", () => {
    const N = 2000;
    const tasks = [task({ id: "R" })];
    for (let i = 0; i < N; i++) tasks.push(task({ id: `l${i}`, parentId: "R", start: "2023-05-22" }));
    tasks.push(task({ id: "Y", start: "2023-05-23", deps: ["R"] }));
    const d = doc(tasks);
    const t0 = performance.now();
    const r = executeCommand(d, { type: "moveTask", id: "R", deltaDays: 1 }, makeCtx());
    const elapsed = performance.now() - t0;
    console.log(`perf: 2000-leaf parent moveTask took ${elapsed.toFixed(1)}ms`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(span(r.doc, "l0")[0]).toBe("2023-05-23");
      expect(span(r.doc, "Y")[0]).toBe("2023-05-24");
    }
    expect(elapsed).toBeLessThan(100);
  });

  it("S26: divergence guard throws SchedulingError", () => {
    // A cyclic document (not constructible via commands) must not hang.
    const d = doc([
      task({ id: "A", start: "2023-05-22", deps: ["B"] }),
      task({ id: "B", start: "2023-05-22", deps: ["A"] }),
    ]);
    expect(() => produce(d, (dr) => rescheduleAll(dr, WC5))).toThrow(SchedulingError);
    expect(() => produce(d, (dr) => schedule(dr, WC5, ["A"], { clampSeeds: false }))).toThrow(
      SchedulingError,
    );
    const r = executeCommand(d, { type: "rescheduleAll" }, makeCtx());
    expect(r).toMatchObject({ ok: false, code: "SCHEDULING_DIVERGED" });
  });

  it("S27: 1000-task serial chain moves in under 200ms", () => {
    const N = 1000;
    const tasks = [];
    // Start on a Monday so each chain link lands on consecutive working days.
    let cursor = "2023-05-22";
    for (let i = 0; i < N; i++) {
      tasks.push(task({ id: `T${i}`, start: cursor, deps: i > 0 ? [`T${i - 1}`] : [] }));
      // next working day after cursor
      const d = new Date(`${cursor}T00:00:00Z`);
      do d.setUTCDate(d.getUTCDate() + 1);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
      cursor = d.toISOString().slice(0, 10);
    }
    const d = doc(tasks);
    expect(findViolations(d, WC5)).toEqual([]);
    const t0 = performance.now();
    const r = executeCommand(d, { type: "moveTask", id: "T0", deltaDays: 1 }, makeCtx());
    const elapsed = performance.now() - t0;
    console.log(`perf: 1000-task chain moveTask took ${elapsed.toFixed(1)}ms`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.tasks[0]!.start).toBe("2023-05-23");
      expect(r.doc.tasks[N - 1]!.start).toBe(tasks[N - 1]!.start === undefined ? "" : shiftOne(tasks[N - 1]!.start!));
      expect(findViolations(r.doc, WC5)).toEqual([]);
    }
    expect(elapsed).toBeLessThan(200);
  });
});

function shiftOne(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
