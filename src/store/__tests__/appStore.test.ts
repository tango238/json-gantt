import { beforeEach, describe, expect, it } from "vitest";
import sample from "../../../schema/examples/sample.json";
import { loadDocument as normalize } from "../../engine";
import { doc as mkDoc, seq, task } from "../../engine/__tests__/fixtures";
import type { GanttDocument } from "../../model/types";
import { setCommandContextOverride, UNDO_LIMIT, useAppStore } from "../appStore";
import {
  isDirty,
  selectDerived,
  selectSelectedTask,
  selectViolations,
  selectVisibleRowIds,
  visibleAncestorOf,
} from "../selectors";

const st = () => useAppStore.getState();
const dirty = () => isDirty(st());

function loadSample(): GanttDocument {
  const r = normalize(structuredClone(sample) as unknown as GanttDocument);
  if (!r.ok) throw new Error("sample invalid");
  st().loadDocument("/tmp/sample.json", r.doc, r.warnings);
  return r.doc;
}
const DEFINE_GOALS = "4652e672-a21d-4222-b9a9-56b4138ea105";

beforeEach(() => {
  setCommandContextOverride({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク" });
  useAppStore.setState({ doc: null, undoStack: [], redoStack: [], preview: null });
});

const markSavedNow = (p: string) => st().markSaved(p, st().undoStack[st().undoStack.length - 1]?.id ?? null, st().doc?.view);

describe("store undo/redo", () => {
  it("U1: undo restores the loaded doc and clears dirty", () => {
    const loaded = loadSample();
    expect(st().dispatch({ type: "moveTask", id: DEFINE_GOALS, deltaDays: 1 }).ok).toBe(true);
    expect(dirty()).toBe(true);
    st().undo();
    expect(st().doc).toEqual(loaded);
    expect(dirty()).toBe(false);
  });

  it("U2: redo reapplies", () => {
    loadSample();
    st().dispatch({ type: "moveTask", id: DEFINE_GOALS, deltaDays: 1 });
    const moved = st().doc;
    st().undo();
    st().redo();
    expect(st().doc).toEqual(moved);
    expect(dirty()).toBe(true);
  });

  it("U3: dirty follows the saved position", () => {
    loadSample();
    st().dispatch({ type: "moveTask", id: DEFINE_GOALS, deltaDays: 1 });
    st().dispatch({ type: "setName", id: DEFINE_GOALS, name: "x" });
    markSavedNow("/tmp/sample.json");
    expect(dirty()).toBe(false);
    st().undo();
    expect(dirty()).toBe(true);
    st().redo();
    expect(dirty()).toBe(false);
  });

  it("U4: no-op command does not touch the stack", () => {
    st().loadDocument(
      null,
      mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" }), task({ id: "B", start: "2023-05-24", deps: ["A"] })]),
    );
    const before = st().doc;
    const r = st().dispatch({ type: "moveTask", id: "B", deltaDays: -2 });
    expect(r.ok).toBe(true);
    expect(st().undoStack).toHaveLength(0);
    expect(st().doc).toEqual(before);
    expect(dirty()).toBe(false);
  });

  it("U5: view changes are dirty but not undoable", () => {
    loadSample();
    st().setZoom("week");
    expect(dirty()).toBe(true);
    expect(st().undoStack).toHaveLength(0);
    st().undo();
    expect(st().doc!.view?.zoom).toBe("week");
    markSavedNow("/tmp/sample.json");
    expect(dirty()).toBe(false);
  });

  it("U5b: undo keeps view changes made after a command", () => {
    loadSample();
    st().dispatch({ type: "moveTask", id: DEFINE_GOALS, deltaDays: 1 });
    st().setZoom("month");
    st().undo();
    expect(st().doc!.view?.zoom).toBe("month");
  });

  it("U6: preview does not touch doc or stacks", () => {
    const loaded = loadSample();
    const alt = { ...loaded, project: { ...loaded.project, name: "preview" } };
    st().setPreview(alt);
    expect(st().doc).toBe(loaded);
    expect(selectDerived(st())).not.toBeNull();
    st().clearPreview();
    expect(st().preview).toBeNull();
    expect(st().doc).toBe(loaded);
    expect(st().undoStack).toHaveLength(0);
    expect(dirty()).toBe(false);
  });

  it("U7: undo stack is capped at 200", () => {
    st().loadDocument(null, mkDoc([task({ id: "A", start: "2023-05-22" })]));
    for (let i = 0; i < 201; i++) {
      expect(st().dispatch({ type: "setName", id: "A", name: `n${i}` }).ok).toBe(true);
    }
    expect(st().undoStack).toHaveLength(UNDO_LIMIT);
    expect(dirty()).toBe(true);
  });

  it("U8: addTask selects the new task and starts name editing", () => {
    loadSample();
    const r = st().dispatch({ type: "addTask", afterId: DEFINE_GOALS });
    expect(r.ok).toBe(true);
    expect(st().selectedId).toBe("N1");
    expect(st().editing).toEqual({ taskId: "N1", field: "name" });
    expect(selectSelectedTask(st())?.id).toBe("N1");
  });

  it("U9: indent into a collapsed parent expands it", () => {
    st().loadDocument(
      null,
      mkDoc([
        task({ id: "P" }),
        task({ id: "C", parentId: "P", start: "2023-05-22" }),
        task({ id: "X", start: "2023-05-22" }),
      ]),
    );
    st().toggleCollapsed("P");
    markSavedNow("/tmp/a.json");
    expect(st().doc!.view?.collapsedTaskIds).toContain("P");
    expect(selectVisibleRowIds(st())).toEqual(["P", "X"]);
    const r = st().dispatch({ type: "indent", id: "X" });
    expect(r.ok).toBe(true);
    expect(st().doc!.view?.collapsedTaskIds).not.toContain("P");
    expect(st().viewDirty).toBe(true);
    expect(selectVisibleRowIds(st())).toEqual(["P", "C", "X"]);
  });

  it("U10: failing command leaves state untouched", () => {
    loadSample();
    const before = st().doc;
    const r = st().dispatch({ type: "indent", id: "b8f04324-e69c-43b3-8436-d6c3b52b5083" });
    expect(r.ok).toBe(false);
    expect(st().doc).toBe(before);
    expect(st().undoStack).toHaveLength(0);
    expect(dirty()).toBe(false);
  });

  it("new command clears redo; undo drops selection of vanished task", () => {
    loadSample();
    st().dispatch({ type: "addTask", afterId: DEFINE_GOALS });
    st().undo();
    expect(st().selectedId).toBeNull();
    expect(st().redoStack).toHaveLength(1);
    st().dispatch({ type: "setName", id: DEFINE_GOALS, name: "y" });
    expect(st().redoStack).toHaveLength(0);
  });
});

describe("selectors", () => {
  it("are reference stable and respect collapse", () => {
    loadSample();
    const rows1 = selectVisibleRowIds(st());
    expect(selectVisibleRowIds(st())).toBe(rows1);
    expect(selectDerived(st())).toBe(selectDerived(st()));
    expect(selectViolations(st())).toBe(selectViolations(st()));
    expect(rows1).toHaveLength(31);
    st().toggleCollapsed("1a95d41c-85fd-4bdf-af7a-0879532e40cc");
    expect(selectVisibleRowIds(st())).toHaveLength(26);
  });

  it("visibleAncestorOf returns the outermost collapsed ancestor", () => {
    st().loadDocument(
      null,
      mkDoc([
        task({ id: "P" }),
        task({ id: "Q", parentId: "P" }),
        task({ id: "L", parentId: "Q", start: "2023-05-22" }),
        task({ id: "Z", start: "2023-05-22" }),
      ]),
    );
    const d = () => st().doc!;
    expect(visibleAncestorOf(d(), "L")).toBe("L");
    st().toggleCollapsed("Q");
    expect(visibleAncestorOf(d(), "L")).toBe("Q");
    st().toggleCollapsed("P");
    expect(visibleAncestorOf(d(), "L")).toBe("P");
    expect(visibleAncestorOf(d(), "P")).toBe("P");
    expect(visibleAncestorOf(d(), "Z")).toBe("Z");
  });
});

describe("store extras", () => {
  it("loadCount increases on every load but not on save", () => {
    const n = st().loadCount;
    loadSample();
    expect(st().loadCount).toBe(n + 1);
    markSavedNow("/tmp/other.json");
    expect(st().loadCount).toBe(n + 1);
    loadSample();
    expect(st().loadCount).toBe(n + 2);
  });

  it("collapseAll / expandAll without a change keep the view clean", () => {
    loadSample();
    st().expandAll();
    expect(st().viewDirty).toBe(false);
    st().collapseAll();
    expect(st().viewDirty).toBe(true);
    markSavedNow("/tmp/sample.json");
    st().collapseAll();
    expect(st().viewDirty).toBe(false);
    st().expandAll();
    expect(st().viewDirty).toBe(true);
  });

  it("dispatch clears the drag preview", () => {
    const loaded = loadSample();
    st().setPreview(loaded);
    expect(st().preview).not.toBeNull();
    st().dispatch({ type: "setName", id: DEFINE_GOALS, name: "x" });
    expect(st().preview).toBeNull();
  });

  it("undo drops a selected dependency that no longer exists", () => {
    st().loadDocument(
      null,
      mkDoc([task({ id: "A", start: "2023-05-22" }), task({ id: "B", start: "2023-05-29" })]),
    );
    st().dispatch({ type: "addDependency", succId: "B", predId: "A" });
    st().selectDependency({ succId: "B", predId: "A" });
    st().undo();
    expect(st().selectedDependency).toBeNull();
    st().redo();
    st().selectDependency({ succId: "B", predId: "a" });
    expect(st().selectedDependency).not.toBeNull();
    st().undo();
    expect(st().selectedDependency).toBeNull();
  });

  it("isDirty stays true when the saved entry fell off the capped undo stack", () => {
    st().loadDocument(null, mkDoc([task({ id: "A", start: "2023-05-22" })]));
    for (let i = 0; i < UNDO_LIMIT; i++) st().dispatch({ type: "setName", id: "A", name: `n${i}` });
    markSavedNow("/tmp/a.json");
    expect(dirty()).toBe(false);
    st().dispatch({ type: "setName", id: "A", name: "next" }); // evicts the oldest entry
    expect(st().undoStack).toHaveLength(UNDO_LIMIT);
    st().undo();
    expect(dirty()).toBe(false); // back at the saved entry
    for (let i = 0; i < UNDO_LIMIT; i++) st().undo();
    expect(st().undoStack).toHaveLength(0);
    expect(dirty()).toBe(true); // the saved state is no longer reachable
  });
});
