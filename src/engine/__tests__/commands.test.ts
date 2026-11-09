import { applyPatches, produce } from "immer";
import { describe, expect, it } from "vitest";
import sample from "../../../schema/examples/sample.json";
import type { GanttDocument } from "../../model/types";
import { executeCommand, type Command, type CommandOk } from "../commands";
import { loadDocument } from "../document";
import { findViolations } from "../scheduling";
import { compileCalendar } from "../calendar";
import { deepEqual } from "../equal";
import { doc, makeCtx, span, task } from "./fixtures";

function run(d: GanttDocument, cmd: Command, ctx = makeCtx()): CommandOk {
  const r = executeCommand(d, cmd, ctx);
  if (!r.ok) throw new Error(`unexpected error ${r.code}`);
  return r;
}
function fail(d: GanttDocument, cmd: Command): string {
  const r = executeCommand(d, cmd, makeCtx());
  if (r.ok) throw new Error("expected failure");
  return r.code;
}
const ids = (d: GanttDocument) => d.tasks.map((t) => t.id);
const get = (d: GanttDocument, id: string) => d.tasks.find((t) => t.id === id)!;

function withResources(d: GanttDocument): GanttDocument {
  return {
    ...d,
    resources: [
      { id: "r1", name: "R1" },
      { id: "r2", name: "R2", color: "#112233" },
    ],
    colorLabels: [{ id: "c1", name: "L1", color: "#AABBCC" }],
  };
}

describe("commands", () => {
  it("K1: addTask after a leaf", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24" }),
    ]);
    const r = run(d, { type: "addTask", afterId: "A" });
    expect(ids(r.doc)).toEqual(["A", "N1", "B"]);
    expect(get(r.doc, "N1")).toEqual({
      id: "N1",
      parentId: null,
      name: "新しいタスク",
      start: "2023-05-22",
      end: "2023-05-23",
      progress: 0,
      resourceIds: [],
      dependencies: [],
    });
    expect(r).toMatchObject({ selection: "N1", editName: true, reveal: ["N1"], createdId: "N1" });
  });

  it("K1b: addTask after a parent goes behind its whole subtree and starts at its derived start", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "a", parentId: "P", start: "2023-05-23", end: "2023-05-24" }),
      task({ id: "B", start: "2023-05-30" }),
    ]);
    const r = run(d, { type: "addTask", afterId: "P" });
    expect(ids(r.doc)).toEqual(["P", "a", "N1", "B"]);
    expect(span(r.doc, "N1")).toEqual(["2023-05-23", "2023-05-23"]);
  });

  it("K2: addTask inherits the parent's resources", () => {
    const d = withResources(
      doc([
        task({ id: "P", resourceIds: ["r1"] }),
        task({ id: "A", parentId: "P", start: "2023-05-22" }),
      ]),
    );
    const r = run(d, { type: "addTask", afterId: "A" });
    expect(get(r.doc, "N1").parentId).toBe("P");
    expect(get(r.doc, "N1").resourceIds).toEqual(["r1"]);
  });

  it("K3: addTask(null) on an empty document lands on the next working day", () => {
    const c = makeCtx("2023-05-27");
    const r = run(doc([]), { type: "addTask", afterId: null }, c);
    expect(span(r.doc, "N1")).toEqual(["2023-05-29", "2023-05-29"]);
    expect(r.doc.tasks).toHaveLength(1);
    const r2 = run(r.doc, { type: "addTask", afterId: null }, c);
    expect(ids(r2.doc)).toEqual(["N1", "N2"]);
  });

  it("K4: setResources on a parent covers all descendants", () => {
    const d = withResources(
      doc([
        task({ id: "P" }),
        task({ id: "A", parentId: "P", start: "2023-05-22" }),
        task({ id: "Q", parentId: "P" }),
        task({ id: "B", parentId: "Q", start: "2023-05-22" }),
      ]),
    );
    const r = run(d, { type: "setResources", id: "P", resourceIds: ["r1", "r2", "r1"] });
    for (const id of ["P", "A", "Q", "B"]) expect(get(r.doc, id).resourceIds).toEqual(["r1", "r2"]);
    expect(get(r.doc, "A").resourceIds).not.toBe(get(r.doc, "B").resourceIds);
    expect(fail(d, { type: "setResources", id: "P", resourceIds: ["zz"] })).toBe("INVALID_VALUE");
  });

  it("K5: parents reject date/progress/hours edits", () => {
    const d = doc([task({ id: "P" }), task({ id: "A", parentId: "P", start: "2023-05-22" })]);
    expect(fail(d, { type: "setProgress", id: "P", progress: 50 })).toBe("PARENT_NOT_EDITABLE");
    expect(fail(d, { type: "setHours", id: "P", hours: 5 })).toBe("PARENT_NOT_EDITABLE");
    expect(fail(d, { type: "setDates", id: "P", start: "2023-05-22", end: "2023-05-23" })).toBe(
      "PARENT_NOT_EDITABLE",
    );
    expect(fail(d, { type: "setDuration", id: "P", days: 2 })).toBe("PARENT_NOT_EDITABLE");
    expect(fail(d, { type: "resizeTaskEnd", id: "P", newEnd: "2023-05-23" })).toBe("PARENT_NOT_EDITABLE");
    expect(fail(d, { type: "resizeTaskStart", id: "P", newStart: "2023-05-23" })).toBe(
      "PARENT_NOT_EDITABLE",
    );
  });

  it("K6: moving a parent shifts all children", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-25", end: "2023-05-26" }),
      task({ id: "B", parentId: "P", start: "2023-05-29" }),
    ]);
    const r = run(d, { type: "moveTask", id: "P", deltaDays: 1 });
    expect(span(r.doc, "A")).toEqual(["2023-05-26", "2023-05-29"]);
    expect(span(r.doc, "B")).toEqual(["2023-05-30", "2023-05-30"]);
  });

  it("K6b: moving a parent backwards, and stopping at its own predecessor", () => {
    const d = doc([
      task({ id: "X", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "P", deps: ["X"] }),
      task({ id: "A", parentId: "P", start: "2023-05-25", end: "2023-05-26" }),
      task({ id: "B", parentId: "P", start: "2023-05-29" }),
    ]);
    const r = run(d, { type: "moveTask", id: "P", deltaDays: -3 });
    // target would be 05-22 (before X's end); clamped to 05-24
    expect(span(r.doc, "A")).toEqual(["2023-05-24", "2023-05-25"]);
    expect(span(r.doc, "B")).toEqual(["2023-05-26", "2023-05-26"]);
    expect(run(d, { type: "moveTask", id: "P", deltaDays: -1 }).doc).toBeDefined();
  });

  it("K7: moving forward snaps to the next working day", () => {
    const d = doc([task({ id: "A", start: "2023-05-22", end: "2023-05-26" })]);
    const r = run(d, { type: "moveTask", id: "A", deltaDays: 5 });
    expect(span(r.doc, "A")).toEqual(["2023-05-29", "2023-06-02"]);
  });

  it("K8: moving backward snaps to the previous working day", () => {
    const d = doc([task({ id: "A", start: "2023-05-29" })]);
    const r = run(d, { type: "moveTask", id: "A", deltaDays: -1 });
    expect(span(r.doc, "A")).toEqual(["2023-05-26", "2023-05-26"]);
  });

  it("K9: resizeTaskEnd snaps back to a working day and never before start", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" })]);
    expect(span(run(d, { type: "resizeTaskEnd", id: "A", newEnd: "2023-05-27" }).doc, "A")[1]).toBe(
      "2023-05-26",
    );
    const d2 = doc([task({ id: "A", start: "2023-05-24", end: "2023-05-25" })]);
    expect(span(run(d2, { type: "resizeTaskEnd", id: "A", newEnd: "2023-05-22" }).doc, "A")[1]).toBe(
      "2023-05-24",
    );
  });

  it("K10: resizeTaskStart snaps forward and drags end along", () => {
    const d = doc([task({ id: "A", start: "2023-05-24", end: "2023-05-25" })]);
    const r = run(d, { type: "resizeTaskStart", id: "A", newStart: "2023-05-27" });
    expect(span(r.doc, "A")).toEqual(["2023-05-29", "2023-05-29"]);
  });

  it("K11: resizeTaskStart stops at the predecessor constraint", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24", end: "2023-05-25", deps: ["A"] }),
    ]);
    const r = run(d, { type: "resizeTaskStart", id: "B", newStart: "2023-05-22" });
    expect(span(r.doc, "B")).toEqual(["2023-05-24", "2023-05-25"]);
    expect(r.patches).toEqual([]);
  });

  it("K12: setDuration", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" })]);
    expect(span(run(d, { type: "setDuration", id: "A", days: 6 }).doc, "A")[1]).toBe("2023-05-29");
    // start on a non-working day: end = addWorkingDays(start, days)
    const d2 = doc([task({ id: "A", start: "2023-05-27", end: "2023-05-27" })]);
    expect(span(run(d2, { type: "setDuration", id: "A", days: 2 }).doc, "A")[1]).toBe("2023-05-30");
    expect(fail(d, { type: "setDuration", id: "A", days: 0 })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "setDuration", id: "A", days: 1.5 })).toBe("INVALID_VALUE");
  });

  it("K13: deleting the last child turns the parent into a leaf keeping its values", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", progress: 10, hours: 3 }),
      task({ id: "B", parentId: "P", start: "2023-05-23", end: "2023-05-24", progress: 60, hours: 5 }),
    ]);
    const r1 = run(d, { type: "deleteTask", id: "A" });
    const r2 = run(r1.doc, { type: "deleteTask", id: "B" });
    expect(get(r2.doc, "P")).toMatchObject({
      start: "2023-05-23",
      end: "2023-05-24",
      progress: 60,
      hours: 5,
    });
    expect(r2.selection).toBe("P"); // no next row; falls back to the previous one
  });

  it("K13b: deleteTask selects the next visible row, or null when nothing is left", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "P" }),
      task({ id: "x", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-22" }),
    ]);
    expect(run(d, { type: "deleteTask", id: "P" }).selection).toBe("B");
    expect(run(d, { type: "deleteTask", id: "A" }).selection).toBe("P");
    const collapsed = { ...d, view: { zoom: "day" as const, collapsedTaskIds: ["P"] } };
    expect(run(collapsed, { type: "deleteTask", id: "A" }).selection).toBe("P");
    const single = doc([task({ id: "A", start: "2023-05-22" })]);
    expect(run(single, { type: "deleteTask", id: "A" }).selection).toBeNull();
  });

  it("K13c: deleting a task hidden under a collapsed parent selects relative to the visible ancestor", () => {
    const d = {
      ...doc([
        task({ id: "A", start: "2023-05-22" }),
        task({ id: "P" }),
        task({ id: "x", parentId: "P", start: "2023-05-22" }),
        task({ id: "B", start: "2023-05-22" }),
      ]),
      view: { zoom: "day" as const, collapsedTaskIds: ["P"] },
    };
    expect(run(d, { type: "deleteTask", id: "x" }).selection).toBe("B");
    const last = {
      ...doc([
        task({ id: "A", start: "2023-05-22" }),
        task({ id: "P" }),
        task({ id: "x", parentId: "P", start: "2023-05-22" }),
      ]),
      view: { zoom: "day" as const, collapsedTaskIds: ["P"] },
    };
    expect(run(last, { type: "deleteTask", id: "x" }).selection).toBe("A");
  });

  it("K30: a colliding generated id is rejected", () => {
    const d = doc([task({ id: "N1", start: "2023-05-22" })]);
    expect(fail(d, { type: "addTask", afterId: "N1" })).toBe("INVALID_VALUE");
  });

  it("K14: duplicateTask copies the subtree and rewires internal dependencies", () => {
    const d = doc([
      task({ id: "X", start: "2023-05-22" }),
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-23", deps: ["X"] }),
      task({ id: "B", parentId: "P", start: "2023-05-24", deps: ["A"] }),
      task({ id: "Y", start: "2023-05-30", deps: ["P"] }),
    ]);
    const r = run(d, { type: "duplicateTask", id: "P" });
    expect(ids(r.doc)).toEqual(["X", "P", "A", "B", "N1", "N2", "N3", "Y"]);
    expect(get(r.doc, "N1").parentId).toBeNull();
    expect(get(r.doc, "N2").parentId).toBe("N1");
    expect(get(r.doc, "N3").dependencies).toEqual([{ predecessorId: "N2" }]);
    expect(get(r.doc, "N2").dependencies).toEqual([{ predecessorId: "X" }]);
    expect(get(r.doc, "N1").dependencies).toEqual([]);
    expect(get(r.doc, "Y").dependencies).toEqual([{ predecessorId: "P" }]);
    expect(get(r.doc, "N2").name).toBe("A");
    expect(r.selection).toBe("N1");
  });

  it("K15: deleteResource removes it from every task", () => {
    const d = withResources(
      doc([
        task({ id: "A", start: "2023-05-22", resourceIds: ["r1", "r2"] }),
        task({ id: "B", start: "2023-05-22", resourceIds: ["r1"] }),
        task({ id: "C", start: "2023-05-22", resourceIds: ["r2"] }),
      ]),
    );
    const r = run(d, { type: "deleteResource", id: "r1" });
    expect(r.doc.resources!.map((x) => x.id)).toEqual(["r2"]);
    expect(r.doc.tasks.map((t) => t.resourceIds)).toEqual([["r2"], [], ["r2"]]);
  });

  it("K17: setDates before the predecessor is pushed back keeping the duration", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24", end: "2023-05-25", deps: ["A"] }),
    ]);
    const r = run(d, { type: "setDates", id: "B", start: "2023-05-22", end: "2023-05-23" });
    expect(span(r.doc, "B")).toEqual(["2023-05-24", "2023-05-25"]);
  });

  it("K18: setDates rejects start after end", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" })]);
    expect(fail(d, { type: "setDates", id: "A", start: "2023-05-25", end: "2023-05-24" })).toBe(
      "START_AFTER_END",
    );
    expect(fail(d, { type: "setDates", id: "A", start: "2023-02-30", end: "2023-05-24" })).toBe(
      "INVALID_VALUE",
    );
    // setDates does not snap to working days
    const r = run(d, { type: "setDates", id: "A", start: "2023-05-27", end: "2023-05-28" });
    expect(span(r.doc, "A")).toEqual(["2023-05-27", "2023-05-28"]);
  });
});

describe("commands: validation and the rest", () => {
  const base = withResources(
    doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-24", deps: ["A"] }),
    ]),
  );

  it("K19: unknown ids and bad values", () => {
    expect(fail(base, { type: "moveTask", id: "zz", deltaDays: 1 })).toBe("TASK_NOT_FOUND");
    expect(fail(base, { type: "moveTask", id: "A", deltaDays: 1.5 })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setProgress", id: "A", progress: 101 })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setProgress", id: "A", progress: NaN })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setHours", id: "A", hours: -1 })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setName", id: "zz", name: "x" })).toBe("TASK_NOT_FOUND");
    expect(fail(base, { type: "resizeTaskEnd", id: "A", newEnd: "bad" })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "resizeTaskStart", id: "A", newStart: "bad" })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "addTask", afterId: "zz" })).toBe("TASK_NOT_FOUND");
    expect(fail(base, { type: "duplicateTask", id: "zz" })).toBe("TASK_NOT_FOUND");
    expect(fail(base, { type: "deleteTask", id: "zz" })).toBe("TASK_NOT_FOUND");
    expect(fail(base, { type: "removeDependency", succId: "A", predId: "B" })).toBe("DEPENDENCY_NOT_FOUND");
    expect(fail(base, { type: "addDependency", succId: "A", predId: "B", lag: 1.5 })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setColorLabel", id: "A", colorLabelId: "zz" })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "indent", id: "A" })).toBe("NO_PREVIOUS_SIBLING");
    expect(fail(base, { type: "outdent", id: "A" })).toBe("NOT_INDENTED");
    expect(fail(base, { type: "moveUp", id: "A" })).toBe("NO_PREVIOUS_SIBLING");
    expect(fail(base, { type: "moveDown", id: "B" })).toBe("NO_NEXT_SIBLING");
  });

  it("K19b: setDependencyLag validation", () => {
    expect(fail(base, { type: "setDependencyLag", succId: "A", predId: "B", lag: 1 })).toBe("DEPENDENCY_NOT_FOUND");
    expect(fail(base, { type: "setDependencyLag", succId: "zz", predId: "A", lag: 1 })).toBe("TASK_NOT_FOUND");
    expect(fail(base, { type: "setDependencyLag", succId: "B", predId: "A", lag: 1.5 })).toBe("INVALID_VALUE");
  });

  it("K20: simple field setters", () => {
    let d = run(base, { type: "setProgress", id: "A", progress: 49.6 }).doc;
    expect(get(d, "A").progress).toBe(50);
    d = run(d, { type: "setHours", id: "A", hours: 2.5 }).doc;
    expect(get(d, "A").hours).toBe(2.5);
    d = run(d, { type: "setHours", id: "A", hours: null }).doc;
    expect("hours" in get(d, "A")).toBe(false);
    d = run(d, { type: "setName", id: "A", name: " x " }).doc;
    expect(get(d, "A").name).toBe(" x ");
    d = run(d, { type: "setNotes", id: "A", notes: "memo" }).doc;
    expect(get(d, "A").notes).toBe("memo");
    d = run(d, { type: "setNotes", id: "A", notes: "" }).doc;
    expect("notes" in get(d, "A")).toBe(false);
    d = run(d, { type: "setColorLabel", id: "A", colorLabelId: "c1" }).doc;
    expect(get(d, "A").colorLabelId).toBe("c1");
    d = run(d, { type: "setColorLabel", id: "A", colorLabelId: null }).doc;
    expect("colorLabelId" in get(d, "A")).toBe(false);
  });

  it("K21: removeDependency and indent/outdent/move commands", () => {
    let d = run(base, { type: "removeDependency", succId: "B", predId: "A" }).doc;
    expect(get(d, "B").dependencies).toEqual([]);
    d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-23" }),
      task({ id: "C", start: "2023-05-24" }),
    ]);
    const ind = run(d, { type: "indent", id: "B" });
    expect(get(ind.doc, "B").parentId).toBe("A");
    expect(ind.reveal).toEqual(["B"]);
    const out = run(ind.doc, { type: "outdent", id: "B" });
    expect(get(out.doc, "B").parentId).toBeNull();
    expect(get(out.doc, "A")).toMatchObject({ start: "2023-05-23", end: "2023-05-23" });
    expect(ids(run(d, { type: "moveDown", id: "A" }).doc)).toEqual(["B", "A", "C"]);
    expect(ids(run(d, { type: "moveUp", id: "C" }).doc)).toEqual(["A", "C", "B"]);
  });

  it("K22: indent re-applies a predecessor constraint inherited from the new parent", () => {
    const d = doc([
      task({ id: "X", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "P", start: "2023-05-24", deps: ["X"] }),
      task({ id: "c", start: "2023-05-24" }),
    ]);
    // c becomes a child of P; P (now a parent) keeps its dependency on X, c is already after it.
    const r = run(d, { type: "indent", id: "c" });
    expect(span(r.doc, "c")).toEqual(["2023-05-24", "2023-05-24"]);
    // indenting a task that sits before the constraint pushes it
    const d2 = doc([
      task({ id: "X", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "P", start: "2023-05-24", deps: ["X"] }),
      task({ id: "c", start: "2023-05-23" }),
    ]);
    expect(span(run(d2, { type: "indent", id: "c" }).doc, "c")[0]).toBe("2023-05-24");
  });

  it("K23: project info, calendar", () => {
    let d = run(base, { type: "setProjectInfo", name: "New", description: "desc" }).doc;
    expect(d.project).toMatchObject({ name: "New", description: "desc" });
    d = run(d, { type: "setProjectInfo", description: "" }).doc;
    expect("description" in d.project).toBe(false);
    d = run(d, {
      type: "setCalendar",
      calendar: { weekends: [6, 0], holidays: ["2023-06-01", "2023-05-29", "2023-06-01"] },
    }).doc;
    expect(d.project.calendar).toEqual({ weekends: [6, 0], holidays: ["2023-05-29", "2023-06-01"] });
    d = run(d, { type: "setCalendar", calendar: null }).doc;
    expect("calendar" in d.project).toBe(false);
    expect(fail(base, { type: "setCalendar", calendar: { weekends: [7], holidays: [] } })).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setCalendar", calendar: { weekends: [1, 1], holidays: [] } })).toBe(
      "INVALID_VALUE",
    );
    expect(
      fail(base, { type: "setCalendar", calendar: { weekends: [0, 1, 2, 3, 4, 5, 6] as unknown as [number], holidays: [] } }),
    ).toBe("INVALID_VALUE");
    expect(fail(base, { type: "setCalendar", calendar: { weekends: [0], holidays: ["2023-13-01"] } })).toBe(
      "INVALID_VALUE",
    );
  });

  it("K24: resource and colour label management", () => {
    let r = run(base, { type: "addResource", name: "R3", color: "#010203" });
    expect(r.createdId).toBe("N1");
    expect(r.doc.resources![r.doc.resources!.length - 1]).toEqual({ id: "N1", name: "R3", color: "#010203" });
    r = run(r.doc, { type: "addResource", name: "R4" }, makeCtx());
    expect(r.doc.resources![r.doc.resources!.length - 1]).toEqual({ id: "N1", name: "R4" });
    let d = run(r.doc, { type: "updateResource", id: "r2", name: "Renamed", color: null }).doc;
    expect(d.resources![1]).toEqual({ id: "r2", name: "Renamed" });
    d = run(d, { type: "updateResource", id: "r2", color: "#FFFFFF" }).doc;
    expect(d.resources![1]!.color).toBe("#FFFFFF");
    expect(fail(d, { type: "updateResource", id: "zz", name: "x" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "updateResource", id: "r1", color: "red" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "addResource", name: "x", color: "red" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "deleteResource", id: "zz" })).toBe("INVALID_VALUE");

    const l = run(d, { type: "addColorLabel", name: "L2", color: "#000000" });
    expect(l.doc.colorLabels![l.doc.colorLabels!.length - 1]).toEqual({ id: "N1", name: "L2", color: "#000000" });
    d = run(l.doc, { type: "updateColorLabel", id: "c1", name: "Z", color: "#111111" }).doc;
    expect(d.colorLabels![0]).toEqual({ id: "c1", name: "Z", color: "#111111" });
    expect(fail(d, { type: "updateColorLabel", id: "zz", name: "x" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "addColorLabel", name: "x", color: "nope" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "updateColorLabel", id: "c1", color: "nope" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "deleteColorLabel", id: "zz" })).toBe("INVALID_VALUE");
    d = run(d, { type: "setColorLabel", id: "A", colorLabelId: "c1" }).doc;
    d = run(d, { type: "deleteColorLabel", id: "c1" }).doc;
    expect(d.colorLabels!.map((c) => c.id)).toEqual(["N1"]);
    expect("colorLabelId" in get(d, "A")).toBe(false);
  });

  it("K25: commands never touch doc.view", () => {
    const d = { ...base, view: { zoom: "week" as const, collapsedTaskIds: ["P"] } };
    for (const cmd of [
      { type: "deleteTask", id: "A" },
      { type: "addTask", afterId: "A" },
      { type: "moveTask", id: "A", deltaDays: 3 },
    ] as Command[]) {
      expect(run(d, cmd).doc.view).toEqual(d.view);
    }
  });

  it("K26: the same input yields the same output (purity)", () => {
    const a = run(base, { type: "moveTask", id: "A", deltaDays: 3 }, makeCtx());
    const b = run(base, { type: "moveTask", id: "A", deltaDays: 3 }, makeCtx());
    expect(a.doc).toEqual(b.doc);
    expect(a.patches).toEqual(b.patches);
  });

  it("K27: the input document is not mutated", () => {
    const snapshot = JSON.stringify(base);
    run(base, { type: "moveTask", id: "A", deltaDays: 3 });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("K28: unexpected exceptions are not swallowed", () => {
    const bad = { ...base, tasks: null } as unknown as GanttDocument;
    expect(() => executeCommand(bad, { type: "moveTask", id: "A", deltaDays: 1 }, makeCtx())).toThrow();
  });

  it("K29: calendar errors surface as CALENDAR_NO_WORKING_DAY", () => {
    const d: GanttDocument = {
      ...base,
      project: { name: "T", calendar: { weekends: [0, 1, 2, 3, 4, 5, 6] as unknown as [number], holidays: [] } },
    };
    expect(fail(d, { type: "moveTask", id: "A", deltaDays: 1 })).toBe("CALENDAR_NO_WORKING_DAY");
  });
});

// K16: inversePatches restore the original for every command type.
describe("K16: inverse patches restore the original document", () => {
  const sampleDoc = (() => {
    const r = loadDocument(sample as unknown as GanttDocument);
    if (!r.ok) throw new Error("sample failed to load");
    return r.doc;
  })();

  const tasks = sampleDoc.tasks;
  const leaf = tasks.find((t) => t.start !== undefined && (t.dependencies?.length ?? 0) > 0)!;
  const parent = tasks.find((t) => t.start === undefined && t.parentId !== null) ?? tasks[0]!;
  const root = tasks[0]!;
  const resId = sampleDoc.resources![0]!.id;
  const labelId = sampleDoc.colorLabels![0]!.id;
  const secondLeaf = tasks.filter((t) => t.start !== undefined && t.parentId === leaf.parentId)[1] ?? leaf;
  // A leaf that has a previous sibling (indent) and one that is indented (outdent)
  const withPrev = tasks.find((t) => t.parentId !== null && t.id !== tasks.find((x) => x.parentId === t.parentId)!.id)!;

  const cases: Array<[string, Command]> = [
    ["moveTask(leaf)", { type: "moveTask", id: leaf.id, deltaDays: 3 }],
    ["moveTask(parent)", { type: "moveTask", id: parent.id, deltaDays: 2 }],
    ["resizeTaskEnd", { type: "resizeTaskEnd", id: leaf.id, newEnd: "2023-06-20" }],
    ["resizeTaskStart", { type: "resizeTaskStart", id: leaf.id, newStart: "2023-06-01" }],
    ["setDates", { type: "setDates", id: leaf.id, start: "2023-06-05", end: "2023-06-09" }],
    ["setDuration", { type: "setDuration", id: leaf.id, days: 4 }],
    ["setProgress", { type: "setProgress", id: leaf.id, progress: 77 }],
    ["setHours", { type: "setHours", id: leaf.id, hours: 12 }],
    ["setName", { type: "setName", id: leaf.id, name: "renamed" }],
    ["setNotes", { type: "setNotes", id: leaf.id, notes: "n" }],
    ["addTask(after)", { type: "addTask", afterId: leaf.id }],
    ["addTask(null)", { type: "addTask", afterId: null }],
    ["duplicateTask", { type: "duplicateTask", id: parent.id }],
    ["deleteTask", { type: "deleteTask", id: parent.id }],
    ["indent", { type: "indent", id: withPrev.id }],
    ["outdent", { type: "outdent", id: leaf.id }],
    ["moveUp", { type: "moveUp", id: secondLeaf.id }],
    ["moveDown", { type: "moveDown", id: tasks[1]!.id }],
    ["setResources", { type: "setResources", id: parent.id, resourceIds: [resId] }],
    ["setColorLabel", { type: "setColorLabel", id: leaf.id, colorLabelId: labelId }],
    ["addDependency", { type: "addDependency", succId: tasks[tasks.length - 1]!.id, predId: root.id === tasks[tasks.length - 1]!.id ? leaf.id : tasks[3]!.id, lag: 2 }],
    ["removeDependency", { type: "removeDependency", succId: leaf.id, predId: leaf.dependencies![0]!.predecessorId }],
    ["setDependencyLag", { type: "setDependencyLag", succId: leaf.id, predId: leaf.dependencies![0]!.predecessorId, lag: (leaf.dependencies![0]!.lag ?? 0) + 5 }],
    ["rescheduleAll", { type: "rescheduleAll" }],
    ["setProjectInfo", { type: "setProjectInfo", name: "N", description: "D" }],
    ["setCalendar", { type: "setCalendar", calendar: { weekends: [0], holidays: ["2023-05-24"] } }],
    ["setCalendar(null)", { type: "setCalendar", calendar: null }],
    ["addResource", { type: "addResource", name: "New", color: "#123456" }],
    ["updateResource", { type: "updateResource", id: resId, name: "Z", color: null }],
    ["deleteResource", { type: "deleteResource", id: resId }],
    ["addColorLabel", { type: "addColorLabel", name: "New", color: "#123456" }],
    ["updateColorLabel", { type: "updateColorLabel", id: labelId, name: "Z", color: "#654321" }],
    ["deleteColorLabel", { type: "deleteColorLabel", id: labelId }],
    [
      "replaceDocument",
      {
        type: "replaceDocument",
        doc: produce(sampleDoc, (d) => {
          d.tasks[0]!.name = "renamed-by-ai";
          d.project.name = "P2";
        }),
      },
    ],
  ];

  // rescheduleAll needs a document that has a violation to produce any patch.
  const violated = produce(sampleDoc, (d) => {
    const t = d.tasks.find((x) => x.id === leaf.id)!;
    t.start = "2023-05-15";
    t.end = "2023-05-15";
  });

  it.each(cases)("K16: %s", (_name, cmd) => {
    const base = cmd.type === "rescheduleAll" ? violated : sampleDoc;
    const original = structuredClone(base);
    const r = executeCommand(base, cmd, makeCtx());
    if (!r.ok) throw new Error(`${cmd.type} failed: ${r.code}`);
    expect(r.patches.length).toBeGreaterThan(0);
    expect(applyPatches(r.doc, r.inversePatches)).toStrictEqual(original);
    expect(applyPatches(base, r.patches)).toStrictEqual(r.doc);
    expect(base).toStrictEqual(original);
  });

  it("K16: parent turned back into a leaf (outdent / deleteTask) is restored", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", end: "2023-05-23", progress: 30, hours: 4 }),
    ]);
    for (const cmd of [
      { type: "outdent", id: "A" },
      { type: "deleteTask", id: "A" },
    ] as Command[]) {
      const original = structuredClone(d);
      const r = run(d, cmd);
      expect(get(r.doc, "P")).toMatchObject({ start: "2023-05-22", end: "2023-05-23", progress: 30, hours: 4 });
      expect(applyPatches(r.doc, r.inversePatches)).toStrictEqual(original);
    }
  });

  it("K16: every Command type is covered", () => {
    const covered = new Set(cases.map(([, c]) => c.type));
    const all: Command["type"][] = [
      "moveTask", "resizeTaskEnd", "resizeTaskStart", "setDates", "setDuration", "setProgress", "setHours",
      "setName", "setNotes", "addTask", "duplicateTask", "deleteTask", "indent", "outdent", "moveUp",
      "moveDown", "setResources", "setColorLabel", "addDependency", "removeDependency", "setDependencyLag", "rescheduleAll",
      "setProjectInfo", "setCalendar", "addResource", "updateResource", "deleteResource", "addColorLabel",
      "updateColorLabel", "deleteColorLabel", "replaceDocument",
    ];
    for (const t of all) expect(covered.has(t)).toBe(true);
  });
});

describe("setDependencyLag", () => {
  const d0 = doc([
    task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
    task({ id: "B", start: "2023-05-24", deps: ["A"] }),
    task({ id: "C", start: "2023-05-25", deps: ["B"] }),
  ]);

  it("L1: a larger lag pushes the successor and its followers", () => {
    const r = run(d0, { type: "setDependencyLag", succId: "B", predId: "A", lag: 2 });
    expect(get(r.doc, "B").dependencies![0]!.lag).toBe(2);
    expect(span(r.doc, "B")).toEqual(["2023-05-26", "2023-05-26"]);
    expect(span(r.doc, "C")).toEqual(["2023-05-29", "2023-05-29"]);
  });

  it("L2: same lag (explicit or implicit zero) returns the original doc without patches", () => {
    const r = run(d0, { type: "setDependencyLag", succId: "B", predId: "A", lag: 0 });
    expect(r.doc).toBe(d0);
    expect(r.patches).toEqual([]);
    const withLag = run(d0, { type: "setDependencyLag", succId: "B", predId: "A", lag: 2 }).doc;
    const same = run(withLag, { type: "setDependencyLag", succId: "B", predId: "A", lag: 2 });
    expect(same.doc).toBe(withLag);
    expect(same.patches).toEqual([]);
  });

  it("L3: lag back to 0 removes the field; a decrease does not pull the successor forward", () => {
    const withLag = run(d0, { type: "setDependencyLag", succId: "B", predId: "A", lag: 2 }).doc;
    const r = run(withLag, { type: "setDependencyLag", succId: "B", predId: "A", lag: 0 });
    expect("lag" in get(r.doc, "B").dependencies![0]!).toBe(false);
    expect(span(r.doc, "B")).toEqual(["2023-05-26", "2023-05-26"]);
  });

  it("L4: predecessor id is matched case-insensitively", () => {
    const r = run(d0, { type: "setDependencyLag", succId: "B", predId: "a", lag: 1 });
    expect(get(r.doc, "B").dependencies![0]!.lag).toBe(1);
  });
});

describe("replaceDocument (E1-E5)", () => {
  const A = task({ id: "A", start: "2023-05-22", end: "2023-05-23" });
  const B = task({ id: "B", start: "2023-05-24", deps: ["A"] });
  const base = { ...doc([A, B]), view: { zoom: "week" as const, collapsedTaskIds: ["A"] } };

  it("E1: a changed name yields patches whose inverse restores the original", () => {
    const next = produce(base, (d) => {
      d.tasks[0]!.name = "renamed";
    });
    const r = run(base, { type: "replaceDocument", doc: next });
    expect(r.patches.length).toBeGreaterThan(0);
    expect(r.doc).toEqual(next);
    expect(applyPatches(r.doc, r.inversePatches)).toEqual(base);
  });

  it("E2: identical content in another instance produces no patches", () => {
    const r = run(base, { type: "replaceDocument", doc: structuredClone(base) });
    expect(r.patches).toEqual([]);
    expect(r.doc).toBe(base);
  });

  it("E3: view is kept from the current document and never appears in patches", () => {
    const next = {
      ...structuredClone(base),
      view: { zoom: "month" as const, collapsedTaskIds: [] },
      project: { ...base.project, name: "changed" },
    };
    const r = run(base, { type: "replaceDocument", doc: next });
    expect(r.doc.view).toEqual(base.view);
    expect(r.doc.project.name).toBe("changed");
    expect(r.patches.some((p) => p.path[0] === "view")).toBe(false);
    // a document without view at all also keeps the current one
    const { view: _v, ...noView } = structuredClone(base);
    const r2 = run(base, { type: "replaceDocument", doc: noView as GanttDocument });
    expect(r2.doc.view).toEqual(base.view);
    expect(r2.patches).toEqual([]);
  });

  it("E4: added task ids are revealed and dependency violations are not rescheduled", () => {
    const next = {
      ...structuredClone(base),
      tasks: [
        task({ id: "A", start: "2023-06-05", end: "2023-06-06" }), // pushes past B without moving it
        B,
        task({ id: "C", start: "2023-06-07" }),
      ],
    };
    const r = run(base, { type: "replaceDocument", doc: next });
    expect(r.reveal).toEqual(["C"]);
    expect(r.selection).toBeUndefined();
    expect(get(r.doc, "B")).toEqual(B);
    expect(findViolations(r.doc, compileCalendar(r.doc.project.calendar)).length).toBeGreaterThan(0);
    // nothing added: no reveal field
    expect(run(base, { type: "replaceDocument", doc: produce(base, (d) => void (d.tasks[0]!.name = "x")) }).reveal).toBeUndefined();
  });

  it("E5: unknown top-level keys are added and removed", () => {
    const withExtra = { ...structuredClone(base), "x-extra": { n: 1 } } as GanttDocument;
    const added = run(base, { type: "replaceDocument", doc: withExtra });
    expect(added.doc["x-extra"]).toEqual({ n: 1 });
    expect(added.patches.some((p) => p.path[0] === "x-extra")).toBe(true);
    const removed = run(added.doc, { type: "replaceDocument", doc: structuredClone(base) });
    expect("x-extra" in removed.doc).toBe(false);
    expect(removed.patches.some((p) => p.op === "remove" && p.path[0] === "x-extra")).toBe(true);
  });
});

describe("deepEqual", () => {
  it("compares JSON values ignoring key order", () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual([1, 2], [1])).toBe(false);
  });
});
