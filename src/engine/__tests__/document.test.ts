import { describe, expect, it } from "vitest";
import sample from "../../../schema/examples/sample.json";
import type { GanttDocument } from "../../model/types";
import { compileCalendar } from "../calendar";
import { executeCommand } from "../commands";
import { createEmptyDocument, loadDocument, prepareForSave } from "../document";
import { findViolations } from "../scheduling";
import { doc, makeCtx, task } from "./fixtures";

const WC = compileCalendar({ weekends: [0, 6], holidays: [] });

function errs(raw: GanttDocument): Array<[string, string]> {
  const r = loadDocument(raw);
  if (r.ok) throw new Error("expected errors");
  return r.errors.map((e) => [e.code, e.path]);
}

describe("document", () => {
  it("L1: sample.json loads cleanly", () => {
    const r = loadDocument(sample as unknown as GanttDocument);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.doc.tasks).toHaveLength(31);
    expect(findViolations(r.doc, WC)).toEqual([]);
    // raw input is not modified
    expect((sample as unknown as GanttDocument).tasks).toHaveLength(31);
  });

  it("L2: duplicate ids (case-insensitive) in tasks, resources and colour labels", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" }), task({ id: "a", start: "2023-05-22" })]);
    expect(errs(d)).toEqual([["DUPLICATE_ID", "/tasks/1/id"]]);
    const d2 = {
      ...doc([task({ id: "A", start: "2023-05-22" })]),
      resources: [{ id: "r", name: "1" }, { id: "R", name: "2" }],
      colorLabels: [{ id: "c", name: "1", color: "#000000" }, { id: "c", name: "2", color: "#000000" }],
    };
    expect(errs(d2)).toEqual([
      ["DUPLICATE_ID", "/resources/1/id"],
      ["DUPLICATE_ID", "/colorLabels/1/id"],
    ]);
  });

  it("L3: a leaf with only start/end gets the other one", () => {
    const a = task({ id: "A", start: "2023-05-22" });
    delete a.end;
    const b = task({ id: "B", start: "2023-05-23" });
    delete b.start;
    delete b.progress;
    const r = loadDocument(doc([a, b]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.tasks[0]).toMatchObject({ start: "2023-05-22", end: "2023-05-22", progress: 0 });
    expect(r.doc.tasks[1]).toMatchObject({ start: "2023-05-23", end: "2023-05-23", progress: 0 });
  });

  it("L4: a leaf without dates is an error", () => {
    expect(errs(doc([task({ id: "A" })]))).toEqual([["LEAF_NO_DATES", "/tasks/0"]]);
  });

  it("L5: parent cycles", () => {
    const d = doc([
      task({ id: "A", parentId: "B", start: "2023-05-22" }),
      task({ id: "B", parentId: "A", start: "2023-05-22" }),
    ]);
    expect(errs(d)).toEqual([
      ["PARENT_CYCLE", "/tasks/0/parentId"],
      ["PARENT_CYCLE", "/tasks/1/parentId"],
    ]);
    // self-parent
    expect(errs(doc([task({ id: "A", parentId: "A", start: "2023-05-22" })]))).toEqual([
      ["PARENT_CYCLE", "/tasks/0/parentId"],
    ]);
  });

  it("L5b: parent cycles stop further checks", () => {
    const d = doc([
      task({ id: "A", parentId: "B" }),
      task({ id: "B", parentId: "A" }),
      task({ id: "C" }), // would be LEAF_NO_DATES
    ]);
    expect(errs(d).map(([c]) => c)).toEqual(["PARENT_CYCLE", "PARENT_CYCLE"]);
  });

  it("L8: parent and dependency errors with paths", () => {
    const d = doc([
      task({ id: "A", parentId: "ghost", start: "2023-05-22", deps: ["ghost"] }),
      task({ id: "B", start: "2023-05-22", deps: ["B", "A", "A"] }),
      { ...task({ id: "C", start: "2023-05-25" }), end: "2023-05-24" },
    ]);
    expect(errs(d)).toEqual([
      ["PARENT_NOT_FOUND", "/tasks/0/parentId"],
      ["DEPENDENCY_NOT_FOUND", "/tasks/0/dependencies/0/predecessorId"],
      ["DEPENDENCY_SELF", "/tasks/1/dependencies/0/predecessorId"],
      ["DEPENDENCY_DUPLICATE", "/tasks/1/dependencies/2/predecessorId"],
      ["START_AFTER_END", "/tasks/2/end"],
    ]);
  });

  it("L9: ancestor dependencies and cycles are reported at dependency paths", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "c", parentId: "P", start: "2023-05-22", deps: ["P"] }),
      task({ id: "X", start: "2023-05-22", deps: ["Y"] }),
      task({ id: "Y", start: "2023-05-22", deps: ["X"] }),
    ]);
    expect(errs(d)).toEqual([
      ["DEPENDENCY_ANCESTOR", "/tasks/1/dependencies/0"],
      ["DEPENDENCY_CYCLE", "/tasks/2/dependencies/0"],
      ["DEPENDENCY_CYCLE", "/tasks/3/dependencies/0"],
    ]);
  });

  it("L9b: every independent dependency cycle is reported", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", deps: ["B"] }),
      task({ id: "B", start: "2023-05-22", deps: ["A"] }),
      task({ id: "C", start: "2023-05-22", deps: ["D"] }),
      task({ id: "D", start: "2023-05-22", deps: ["C"] }),
      task({ id: "E", start: "2023-05-22", deps: ["A"] }),
    ]);
    expect(errs(d)).toEqual([
      ["DEPENDENCY_CYCLE", "/tasks/0/dependencies/0"],
      ["DEPENDENCY_CYCLE", "/tasks/1/dependencies/0"],
      ["DEPENDENCY_CYCLE", "/tasks/2/dependencies/0"],
      ["DEPENDENCY_CYCLE", "/tasks/3/dependencies/0"],
    ]);
  });

  it("L10: warnings for unknown references and violations; values are kept", () => {
    const d = doc([
      { ...task({ id: "A", start: "2023-05-22", end: "2023-05-24", resourceIds: ["ghost"] }), colorLabelId: "nolabel" },
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
    ]);
    const r = loadDocument(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ["UNKNOWN_RESOURCE", "/tasks/0/resourceIds/0"],
      ["UNKNOWN_COLOR_LABEL", "/tasks/0/colorLabelId"],
      ["DEPENDENCY_VIOLATION", "/tasks/1/dependencies/0"],
    ]);
    expect(r.doc.tasks[1]!.start).toBe("2023-05-23");
  });

  it("L11: defaults for missing optional structures", () => {
    const raw = {
      version: 1,
      project: { name: "x" },
      tasks: [{ id: "A", name: "A", start: "2023-05-22" }],
    } as unknown as GanttDocument;
    const r = loadDocument(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.resources).toEqual([]);
    expect(r.doc.colorLabels).toEqual([]);
    expect(r.doc.view).toEqual({ zoom: "day", collapsedTaskIds: [] });
    expect(r.doc.tasks[0]).toMatchObject({ parentId: null, resourceIds: [], dependencies: [], progress: 0 });
    const r2 = loadDocument({ ...raw, view: {} });
    if (r2.ok) expect(r2.doc.view).toEqual({ zoom: "day", collapsedTaskIds: [] });
  });

  it("L6: prepareForSave drops stale and leaf collapsed ids and orders by display order", () => {
    const d: GanttDocument = {
      ...doc([
        task({ id: "P" }),
        task({ id: "c", parentId: "P", start: "2023-05-22" }),
        task({ id: "Q" }),
        task({ id: "d", parentId: "Q", start: "2023-05-22" }),
      ]),
      view: { zoom: "day", collapsedTaskIds: ["Q", "gone", "c", "P"] },
    };
    expect(prepareForSave(d).view!.collapsedTaskIds).toEqual(["P", "Q"]);
  });

  it("L6b: prepareForSave tidies holidays, empty strings and derived keys", () => {
    const d: GanttDocument = {
      ...doc([
        { ...task({ id: "P" }), start: "2023-05-01", notes: "" },
        task({ id: "c", parentId: "P", start: "2023-05-22" }),
      ]),
    };
    d.project.description = "";
    d.project.calendar = { weekends: [0, 6], holidays: ["2023-06-02", "2023-05-29", "2023-06-02"] };
    const out = prepareForSave(d);
    expect(out.project.calendar!.holidays).toEqual(["2023-05-29", "2023-06-02"]);
    expect("description" in out.project).toBe(false);
    expect("notes" in out.tasks[0]!).toBe(false);
    expect("start" in out.tasks[0]!).toBe(false);
    // input untouched
    expect(d.project.calendar.holidays).toHaveLength(3);
    const noView = { ...d, view: undefined } as unknown as GanttDocument;
    expect(prepareForSave(noView).view).toEqual({ zoom: "day", collapsedTaskIds: [] });
  });

  it("L7: unknown fields survive load, commands and prepareForSave", () => {
    const raw = structuredClone(sample) as unknown as GanttDocument;
    (raw.tasks[3] as Record<string, unknown>).custom = { x: 1 };
    (raw as Record<string, unknown>).topLevelUnknown = [1, 2];
    const r = loadDocument(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.doc.tasks.find((t) => (t as Record<string, unknown>).custom !== undefined)!.id;
    const c = executeCommand(r.doc, { type: "moveTask", id, deltaDays: 1 }, makeCtx());
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const saved = prepareForSave(c.doc);
    expect((saved.tasks.find((t) => t.id === id) as Record<string, unknown>).custom).toEqual({ x: 1 });
    expect((saved as Record<string, unknown>).topLevelUnknown).toEqual([1, 2]);
  });

  it("L12: createEmptyDocument", () => {
    expect(createEmptyDocument({ projectName: "P" })).toEqual({
      version: 1,
      project: { name: "P" },
      resources: [],
      colorLabels: [],
      tasks: [],
      view: { zoom: "day", collapsedTaskIds: [] },
    });
  });
});
