import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { CommandRejected } from "../errors";
import {
  buildTreeIndex,
  collapseAll,
  deleteTasks,
  deriveAll,
  displayOrder,
  expandAll,
  getAncestors,
  getChildren,
  getDerived,
  getDepth,
  getDescendants,
  getLeafDescendantsOrSelf,
  getSubtreeRange,
  indent,
  isParent,
  moveDown,
  moveUp,
  nextSibling,
  outdent,
  previousSibling,
  projectProgress,
  revealTask,
  setCollapsed,
  toggleCollapsed,
  visibleRows,
  weightedProgress,
  effectiveEnd,
  effectiveStart,
  type DerivedTask,
} from "../hierarchy";
import type { GanttDocument, ViewSettings } from "../../model/types";
import { executeCommand } from "../commands";
import { loadDocument } from "../document";
import { WC0, WC5, byId, doc, makeCtx, task } from "./fixtures";

const ids = (d: GanttDocument) => d.tasks.map((t) => t.id);

function rejection(fn: () => unknown): CommandRejected {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommandRejected) return e;
    throw e;
  }
  throw new Error("expected CommandRejected");
}

describe("hierarchy: derivation", () => {
  it("H1: hours-weighted parent progress", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", end: "2023-05-23", hours: 8, progress: 100 }),
      task({ id: "B", parentId: "P", start: "2023-05-24", end: "2023-05-26", hours: 24, progress: 0 }),
    ]);
    const p = getDerived(deriveAll(d, WC5), "P")!;
    expect(p).toMatchObject({
      start: "2023-05-22",
      end: "2023-05-26",
      hours: 32,
      progress: 25,
      durationDays: 5,
      isParent: true,
      childIds: ["A", "B"],
    });
  });

  it("H2: falls back to duration-weighted progress", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", end: "2023-05-23", progress: 100 }),
      task({ id: "B", parentId: "P", start: "2023-05-24", end: "2023-05-26", hours: 8, progress: 0 }),
    ]);
    const p = getDerived(deriveAll(d, WC5), "P")!;
    expect(p.progress).toBeCloseTo(40, 10);
    expect(p.hours).toBe(8);
  });

  it("H3: three levels derive recursively", () => {
    const d = doc([
      task({ id: "G" }),
      task({ id: "P", parentId: "G" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", progress: 100 }),
      task({ id: "C", parentId: "G", start: "2023-05-29", end: "2023-05-30", progress: 0 }),
    ]);
    const di = deriveAll(d, WC5);
    expect(getDerived(di, "P")).toMatchObject({ start: "2023-05-22", end: "2023-05-22", progress: 100 });
    const g = getDerived(di, "G")!;
    expect(g.start).toBe("2023-05-22");
    expect(g.end).toBe("2023-05-30");
    expect(g.progress).toBeCloseTo(100 / 3, 10);
    expect(g.hours).toBeUndefined();
    expect(getDerived(di, "A")!.depth).toBe(2);
    expect(di.order).toEqual(["G", "P", "A", "C"]);
    expect(di.rootIds).toEqual(["G"]);
  });

  it("H3b: weightedProgress edge cases", () => {
    const mk = (over: Partial<DerivedTask>): DerivedTask => ({
      id: "x",
      isParent: false,
      depth: 0,
      childIds: [],
      start: "2023-05-27",
      end: "2023-05-27",
      durationDays: 0,
      hours: undefined,
      progress: 0,
      ...over,
    });
    expect(weightedProgress([])).toBe(0);
    // all zero-duration -> plain average
    expect(weightedProgress([mk({ progress: 100 }), mk({ progress: 0 })])).toBe(50);
    // hours all defined but sum 0 -> duration weighted
    expect(
      weightedProgress([
        mk({ hours: 0, durationDays: 1, progress: 100 }),
        mk({ hours: 0, durationDays: 3, progress: 0 }),
      ]),
    ).toBe(25);
  });

  it("H3c: projectProgress and hours stay undefined when no child has hours", () => {
    expect(projectProgress(deriveAll(doc([]), WC5))).toBe(0);
    const d = doc([
      task({ id: "A", start: "2023-05-22", progress: 100 }),
      task({ id: "B", start: "2023-05-23", progress: 0 }),
    ]);
    expect(projectProgress(deriveAll(d, WC5))).toBe(50);
  });
});

describe("hierarchy: structure changes", () => {
  it("H4: indent makes the previous sibling a parent", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23", progress: 50, hours: 8 }),
      task({ id: "B", start: "2023-05-24", progress: 0 }),
    ]);
    const next = produce(d, (dr) => indent(dr, "B"));
    expect(ids(next)).toEqual(["A", "B"]);
    expect(byId(next, "B").parentId).toBe("A");
    const a = byId(next, "A");
    expect("start" in a).toBe(false);
    expect("end" in a).toBe(false);
    expect("progress" in a).toBe(false);
    expect("hours" in a).toBe(false);
  });

  it("H5: indent without previous sibling is rejected", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" }), task({ id: "B", start: "2023-05-24" })]);
    const e = rejection(() => produce(d, (dr) => indent(dr, "A")));
    expect(e.code).toBe("NO_PREVIOUS_SIBLING");
    expect(ids(d)).toEqual(["A", "B"]);
  });

  it("H4b: indent appends as last child of a previous sibling that already has children", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-24" }),
    ]);
    const next = produce(d, (dr) => indent(dr, "B"));
    expect(ids(next)).toEqual(["P", "A", "B"]);
    expect(byId(next, "B").parentId).toBe("P");
  });

  it("H4c: indent check hook can reject", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" }), task({ id: "B", start: "2023-05-24" })]);
    const e = rejection(() =>
      produce(d, (dr) =>
        indent(
          dr,
          "B",
          () => false,
        ),
      ),
    );
    expect(e.code).toBe("DEPENDENCY_CONFLICT");
  });

  it("H6: outdent moves behind the old parent's subtree", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", parentId: "P", start: "2023-05-23" }),
      task({ id: "C", parentId: "P", start: "2023-05-24" }),
    ]);
    const next = produce(d, (dr) => {
      outdent(dr, "B", WC5);
    });
    expect(ids(next)).toEqual(["P", "A", "C", "B"]);
    expect(byId(next, "B").parentId).toBeNull();
    expect(byId(next, "C").parentId).toBe("P");
  });

  it("H6b: outdent carries the subtree block and places after parent's nested subtree", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "Q", parentId: "P" }),
      task({ id: "q1", parentId: "Q", start: "2023-05-22" }),
      task({ id: "q2", parentId: "Q", start: "2023-05-23" }),
      task({ id: "R", parentId: "P", start: "2023-05-24" }),
    ]);
    const next = produce(d, (dr) => {
      outdent(dr, "Q", WC5);
    });
    expect(ids(next)).toEqual(["P", "R", "Q", "q1", "q2"]);
    expect(byId(next, "q1").parentId).toBe("Q");
  });

  it("H7: outdenting the only child turns the parent into a leaf", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", end: "2023-05-23", progress: 100, hours: 8 }),
    ]);
    let became: string | null = null;
    const next = produce(d, (dr) => {
      became = outdent(dr, "A", WC5);
    });
    expect(became).toBe("P");
    expect(byId(next, "P")).toMatchObject({
      start: "2023-05-22",
      end: "2023-05-23",
      progress: 100,
      hours: 8,
    });
    expect(ids(next)).toEqual(["P", "A"]);
  });

  it("H7b: outdent rejects a root task; leaf-ified parent omits hours when undefined", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" })]);
    expect(rejection(() => produce(d, (dr) => void outdent(dr, "A", WC5))).code).toBe("NOT_INDENTED");
    const d2 = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", progress: 33 }),
    ]);
    const next = produce(d2, (dr) => {
      outdent(dr, "A", WC5);
    });
    expect("hours" in byId(next, "P")).toBe(false);
    expect(byId(next, "P").progress).toBe(33);
  });

  it("H7c: outdent check hook can reject", () => {
    const d = doc([task({ id: "P" }), task({ id: "A", parentId: "P", start: "2023-05-22" })]);
    expect(rejection(() => produce(d, (dr) => void outdent(dr, "A", WC5, () => false))).code).toBe(
      "DEPENDENCY_CONFLICT",
    );
  });

  it("H8: moveUp swaps whole subtree blocks", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "P" }),
      task({ id: "x", parentId: "P", start: "2023-05-22" }),
      task({ id: "y", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-22" }),
    ]);
    const next = produce(d, (dr) => moveUp(dr, "B"));
    expect(ids(next)).toEqual(["A", "B", "P", "x", "y"]);
  });

  it("H8b: moveDown and error codes", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "P" }),
      task({ id: "x", parentId: "P", start: "2023-05-22" }),
    ]);
    const next = produce(d, (dr) => moveDown(dr, "A"));
    expect(ids(next)).toEqual(["P", "x", "A"]);
    expect(rejection(() => produce(d, (dr) => moveDown(dr, "P"))).code).toBe("NO_NEXT_SIBLING");
    expect(rejection(() => produce(d, (dr) => moveUp(dr, "A"))).code).toBe("NO_PREVIOUS_SIBLING");
    expect(rejection(() => produce(d, (dr) => moveUp(dr, "zz"))).code).toBe("TASK_NOT_FOUND");
    expect(rejection(() => produce(d, (dr) => moveDown(dr, "zz"))).code).toBe("TASK_NOT_FOUND");
  });

  it("H9: deleteTasks removes subtree and dangling dependencies", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", parentId: "P", start: "2023-05-23" }),
      task({ id: "X", start: "2023-05-24", deps: ["A"] }),
    ]);
    const next = produce(d, (dr) => {
      deleteTasks(dr, ["P"], WC5);
    });
    expect(ids(next)).toEqual(["X"]);
    expect(byId(next, "X").dependencies).toEqual([]);
  });

  it("H9b: deleteTasks keeps other dependencies and fixes up emptied parents", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22", progress: 40 }),
      task({ id: "Z", start: "2023-05-22" }),
      task({ id: "X", start: "2023-05-24", deps: ["A", "Z"] }),
    ]);
    let leafified: string[] = [];
    const next = produce(d, (dr) => {
      leafified = deleteTasks(dr, ["A"], WC5);
    });
    expect(leafified).toEqual(["P"]);
    expect(byId(next, "P")).toMatchObject({ start: "2023-05-22", end: "2023-05-22", progress: 40 });
    expect(byId(next, "X").dependencies).toEqual([{ predecessorId: "Z" }]);
    expect(rejection(() => produce(d, (dr) => void deleteTasks(dr, ["nope"], WC5))).code).toBe(
      "TASK_NOT_FOUND",
    );
  });
});

describe("hierarchy: tree index", () => {
  const d = doc([
    task({ id: "A" }),
    task({ id: "a1", parentId: "A" }),
    task({ id: "a1x", parentId: "a1", start: "2023-05-22", end: "2023-05-24" }),
    task({ id: "a2", parentId: "A", start: "2023-05-25" }),
    task({ id: "B", start: "2023-05-29" }),
  ]);
  const ix = buildTreeIndex(d);

  it("navigates the tree", () => {
    expect(getChildren(ix, null)).toEqual(["A", "B"]);
    expect(getChildren(ix, "A")).toEqual(["a1", "a2"]);
    expect(getChildren(ix, "B")).toEqual([]);
    expect(isParent(ix, "A")).toBe(true);
    expect(isParent(ix, "B")).toBe(false);
    expect(getDepth(ix, "a1x")).toBe(2);
    expect(getAncestors(ix, "a1x")).toEqual(["a1", "A"]);
    expect(getDescendants(ix, "A")).toEqual(["a1", "a1x", "a2"]);
    expect(getLeafDescendantsOrSelf(ix, "A")).toEqual(["a1x", "a2"]);
    expect(getLeafDescendantsOrSelf(ix, "B")).toEqual(["B"]);
    expect(getSubtreeRange(d, ix, "A")).toEqual([0, 4]);
    expect(getSubtreeRange(d, ix, "a1")).toEqual([1, 3]);
    expect(() => getSubtreeRange(d, ix, "zz")).toThrow(CommandRejected);
    expect(displayOrder(ix)).toEqual(["A", "a1", "a1x", "a2", "B"]);
    expect(previousSibling(ix, "a2")).toBe("a1");
    expect(previousSibling(ix, "a1")).toBeNull();
    expect(previousSibling(ix, "zz")).toBeNull();
    expect(nextSibling(ix, "a1")).toBe("a2");
    expect(nextSibling(ix, "a2")).toBeNull();
    expect(nextSibling(ix, "zz")).toBeNull();
    expect(effectiveStart(ix, "A")).toBe("2023-05-22");
    expect(effectiveEnd(ix, "A")).toBe("2023-05-25");
  });

  it("is case-insensitive on ids", () => {
    const dd = doc([task({ id: "AbC" }), task({ id: "d", parentId: "abc", start: "2023-05-22" })]);
    const i2 = buildTreeIndex(dd);
    expect(getChildren(i2, "ABC")).toEqual(["d"]);
  });

  it("computes visible rows and view operations", () => {
    expect(visibleRows(ix, new Set(["a1"]))).toEqual(["A", "a1", "a2", "B"]);
    expect(visibleRows(ix, new Set(["A"]))).toEqual(["A", "B"]);
    expect(visibleRows(ix, new Set())).toEqual(["A", "a1", "a1x", "a2", "B"]);
    // leaf ids in the collapsed set are ignored
    expect(visibleRows(ix, new Set(["B"]))).toEqual(["A", "a1", "a1x", "a2", "B"]);

    let v: ViewSettings = { zoom: "day", collapsedTaskIds: [] };
    v = toggleCollapsed(v, "A");
    expect(v.collapsedTaskIds).toEqual(["A"]);
    expect(setCollapsed(v, "A", true)).toBe(v);
    v = toggleCollapsed(v, "A");
    expect(v.collapsedTaskIds).toEqual([]);
    expect(collapseAll(v, ix).collapsedTaskIds).toEqual(["A", "a1"]);
    expect(expandAll(collapseAll(v, ix)).collapsedTaskIds).toEqual([]);
    expect(expandAll(v)).toBe(v);
    const c = collapseAll(v, ix);
    expect(revealTask(c, ix, "a1x").collapsedTaskIds).toEqual([]);
    expect(revealTask(c, ix, "a2").collapsedTaskIds).toEqual(["a1"]);
    expect(revealTask(c, ix, "B")).toBe(c);
    expect(toggleCollapsed({ zoom: "day" }, "A").collapsedTaskIds).toEqual(["A"]);
  });

  it("works without a calendar", () => {
    expect(getDerived(deriveAll(d, WC0), "A")!.durationDays).toBe(4);
  });
});

describe("hierarchy: commands and loading (WP3)", () => {
  it("H9c: deleteTask command removes the subtree and dangling dependencies", () => {
    const d = doc([
      task({ id: "P" }),
      task({ id: "A", parentId: "P", start: "2023-05-22" }),
      task({ id: "B", parentId: "P", start: "2023-05-23" }),
      task({ id: "X", start: "2023-05-24", deps: ["A"] }),
    ]);
    const r = executeCommand(d, { type: "deleteTask", id: "P" }, makeCtx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ids(r.doc)).toEqual(["X"]);
    expect(byId(r.doc, "X").dependencies).toEqual([]);
  });

  it("H10: indenting under a task it depends on is a DEPENDENCY_CONFLICT", () => {
    const d = doc([
      task({ id: "A", start: "2023-05-22" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
    ]);
    const r = executeCommand(d, { type: "indent", id: "B" }, makeCtx());
    expect(r).toMatchObject({ ok: false, code: "DEPENDENCY_CONFLICT" });
  });

  it("H11: loadDocument sorts tasks into pre-order", () => {
    const raw = doc([
      task({ id: "x", parentId: "P", start: "2023-05-22" }),
      task({ id: "P" }),
      task({ id: "A", start: "2023-05-22" }),
    ]);
    const r = loadDocument(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(ids(r.doc)).toEqual(["P", "x", "A"]);
    // input untouched
    expect(ids(raw)).toEqual(["x", "P", "A"]);
  });

  it("H12: derived keys on parents are dropped with a warning", () => {
    const raw = doc([
      { ...task({ id: "P" }), start: "2023-05-01", progress: 50 },
      task({ id: "c", parentId: "P", start: "2023-05-22" }),
    ]);
    const r = loadDocument(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("start" in byId(r.doc, "P")).toBe(false);
    expect("progress" in byId(r.doc, "P")).toBe(false);
    expect(r.warnings).toEqual([{ code: "PARENT_DERIVED_IGNORED", path: "/tasks/0", params: { count: 2 } }]);
  });
});
