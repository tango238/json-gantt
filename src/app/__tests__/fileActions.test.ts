import { beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../../../schema/examples/sample.json";
import { useUiStore } from "../../components/uiStore";
import { useAppStore } from "../../store/appStore";
import { isDirty } from "../../store/selectors";

vi.mock("../../tauri/isTauri", () => ({ isTauri: () => true }));
vi.mock("../../export/exportPdf", () => ({ exportPdf: vi.fn(async () => "/out.pdf") }));
let dragging = false;
vi.mock("../../components/chart/useDrag", () => ({ isDragActive: () => dragging }));
vi.mock("../../tauri/api", () => ({
  unwatchFile: vi.fn(async () => undefined),
  openFile: vi.fn(),
  saveFile: vi.fn(),
  getRecentFiles: vi.fn(async () => []),
  addRecentFile: vi.fn(async () => undefined),
  watchFile: vi.fn(async () => undefined),
  newWindow: vi.fn(async () => "doc-1"),
  focusWindowWithFile: vi.fn(async () => false),
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  destroyWindow: vi.fn(async () => undefined),
}));

import * as api from "../../tauri/api";
import * as fa from "../fileActions";
const resetFileUi = fa.resetFileUi;
import { useFileUi } from "../fileUiStore";

const m = vi.mocked(api);
const st = () => useAppStore.getState();
const fresh = () => structuredClone(sample);

async function openSample() {
  m.openFile.mockResolvedValueOnce({ document: fresh(), warnings: [] });
  await fa.openPath("/a/sample.json");
}

let modal = false;
let activeEl: unknown = null;
beforeEach(() => {
  vi.clearAllMocks();
  dragging = false;
  modal = false;
  activeEl = null;
  vi.stubGlobal("document", {
    querySelector: () => (modal ? {} : null),
    get activeElement() {
      return activeEl;
    },
  });
  m.focusWindowWithFile.mockResolvedValue(false);
  useAppStore.setState({ doc: null, filePath: null, undoStack: [], redoStack: [] });
  useUiStore.setState({ toasts: [] });
  resetFileUi();
});

describe("fileActions", () => {
  it("opens into an empty window, registers recent and watcher", async () => {
    await openSample();
    expect(st().doc).not.toBeNull();
    expect(st().filePath).toBe("/a/sample.json");
    expect(m.addRecentFile).toHaveBeenCalledWith("/a/sample.json");
    expect(m.watchFile).toHaveBeenCalledWith("/a/sample.json");
  });

  it("opens in a new window when a document is already open", async () => {
    await openSample();
    await fa.openPath("/b.json");
    expect(m.newWindow).toHaveBeenCalledWith("/b.json");
    expect(m.openFile).toHaveBeenCalledTimes(1);
  });

  it("focuses the window that already has the file", async () => {
    m.focusWindowWithFile.mockResolvedValueOnce(true);
    await fa.openPath("/a.json");
    expect(m.openFile).not.toHaveBeenCalled();
    expect(m.newWindow).not.toHaveBeenCalled();
  });

  it("save success marks the document saved", async () => {
    await openSample();
    st().dispatch({ type: "addTask", afterId: null });
    expect(isDirty(st())).toBe(true);
    m.saveFile.mockResolvedValueOnce(undefined);
    expect(await fa.saveFile()).toBe(true);
    expect(m.saveFile).toHaveBeenCalledWith("/a/sample.json", st().doc);
    expect(isDirty(st())).toBe(false);
    expect(m.watchFile).toHaveBeenLastCalledWith("/a/sample.json");
  });

  it("untitled document saves through Save As", async () => {
    await fa.newDocument();
    m.saveDialog.mockResolvedValueOnce("/x/new");
    expect(await fa.saveFile()).toBe(true);
    expect(m.saveFile).toHaveBeenCalledWith("/x/new.json", expect.anything());
    expect(st().filePath).toBe("/x/new.json");
  });

  it("SCHEMA_INVALID on open sets the error dialog state and keeps the window empty", async () => {
    m.openFile.mockRejectedValueOnce({
      kind: "SCHEMA_INVALID",
      errors: [{ path: "/tasks/0/id", code: "required", message: "missing", params: { property: "id" } }],
    });
    await fa.openPath("/bad.json");
    const e = useFileUi.getState().schemaError;
    expect(e?.filePath).toBe("/bad.json");
    expect(e?.issues[0]).toMatchObject({ code: "required", path: "/tasks/0/id" });
    expect(st().doc).toBeNull();
  });

  it("SCHEMA_INVALID on save shows the dialog and stays dirty", async () => {
    await openSample();
    st().dispatch({ type: "addTask", afterId: null });
    m.saveFile.mockRejectedValueOnce({ kind: "SCHEMA_INVALID", errors: [{ path: "/x", code: "type", message: "m" }] });
    expect(await fa.saveFile()).toBe(false);
    expect(useFileUi.getState().schemaError?.issues).toHaveLength(1);
    expect(isDirty(st())).toBe(true);
  });

  it("external change (clean) -> reload replaces the doc and clears undo history", async () => {
    await openSample();
    fa.handleExternalChange({ path: "/a/sample.json", kind: "modified" });
    expect(useFileUi.getState().externalChange).toBe("changed");
    st().dispatch({ type: "addTask", afterId: null });
    // dirty now -> a second notification asks differently
    fa.handleExternalChange({ path: "/a/sample.json", kind: "modified" });
    expect(useFileUi.getState().externalChange).toBe("changedDirty");

    const changed = fresh() as typeof sample;
    changed.project.name = "Changed outside";
    m.openFile.mockResolvedValueOnce({ document: changed, warnings: [] });
    await fa.reloadFromDisk();
    expect(st().doc?.project.name).toBe("Changed outside");
    expect(st().undoStack).toHaveLength(0);
    expect(isDirty(st())).toBe(false);
    expect(useFileUi.getState().externalChange).toBeNull();
  });

  it("removed file and foreign paths", async () => {
    await openSample();
    fa.handleExternalChange({ path: "/other.json", kind: "removed" });
    expect(useFileUi.getState().externalChange).toBeNull();
    fa.handleExternalChange({ path: "/a/sample.json", kind: "removed" });
    expect(useFileUi.getState().externalChange).toBe("removed");
  });

  it("close with unsaved changes asks first; discard destroys", async () => {
    await openSample();
    const ev = { preventDefault: vi.fn() };
    fa.handleCloseRequested(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    st().dispatch({ type: "addTask", afterId: null });
    fa.handleCloseRequested(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(useFileUi.getState().unsavedClose).toBe(true);
    await fa.closeDiscarding();
    expect(m.destroyWindow).toHaveBeenCalled();
  });

  it("reload without unsaved changes (clean) replaces the doc", async () => {
    await openSample();
    expect(isDirty(st())).toBe(false);
    const changed = fresh() as typeof sample;
    changed.project.name = "Clean reload";
    m.openFile.mockResolvedValueOnce({ document: changed, warnings: [] });
    await fa.reloadFromDisk();
    expect(st().doc?.project.name).toBe("Clean reload");
    expect(isDirty(st())).toBe(false);
  });

  it("M1: an edit made while saving stays dirty", async () => {
    await openSample();
    st().dispatch({ type: "addTask", afterId: null });
    m.saveFile.mockImplementationOnce(async () => {
      st().dispatch({ type: "addTask", afterId: null });
    });
    expect(await fa.saveFile()).toBe(true);
    expect(isDirty(st())).toBe(true);
  });

  it("M1: a view change made while saving stays dirty", async () => {
    await openSample();
    m.saveFile.mockImplementationOnce(async () => {
      st().setZoom("week");
    });
    await fa.saveFile();
    expect(isDirty(st())).toBe(true);
  });

  it("M2: engine validation failure on a fresh window unwatches", async () => {
    const bad = fresh() as typeof sample;
    (bad.tasks[0] as { parentId?: string }).parentId = "no-such-task";
    m.openFile.mockResolvedValueOnce({ document: bad, warnings: [] });
    await fa.openPath("/bad.json");
    expect(st().doc).toBeNull();
    expect(useFileUi.getState().schemaError).not.toBeNull();
    expect(m.unwatchFile).toHaveBeenCalled();
  });

  it("M2: engine validation failure keeps the watcher when a document is open", async () => {
    await openSample();
    const bad = fresh() as typeof sample;
    (bad.tasks[0] as { parentId?: string }).parentId = "no-such-task";
    m.openFile.mockResolvedValueOnce({ document: bad, warnings: [] });
    await fa.reloadFromDisk();
    expect(m.unwatchFile).not.toHaveBeenCalled();
    expect(st().doc).not.toBeNull();
  });

  it("M2: new document in an empty window unwatches first", async () => {
    await fa.newDocument();
    expect(m.unwatchFile).toHaveBeenCalled();
    expect(st().doc).not.toBeNull();
  });

  it("M4: new with a document opens a blank new window", async () => {
    await openSample();
    await fa.newDocument();
    expect(m.newWindow).toHaveBeenCalledWith(null, true);
  });

  it("M4: ?new=1 starts a new document, other queries do not", async () => {
    expect(fa.startupNewDocument("?x=1")).toBe(false);
    expect(st().doc).toBeNull();
    expect(fa.startupNewDocument("?new=1")).toBe(true);
    await vi.waitFor(() => expect(st().doc).not.toBeNull());
  });

  it("m6: IO error on open is shown in the dialog and refreshes recent", async () => {
    m.openFile.mockRejectedValueOnce({ kind: "IO", message: "denied" });
    await fa.openPath("/gone.json");
    const e = useFileUi.getState().schemaError;
    expect(e?.issues[0]).toMatchObject({ code: "IO_ERROR", params: { message: "denied" } });
    expect(m.getRecentFiles).toHaveBeenCalled();
  });

  it("m7: Rust issue params of any JSON type become strings", async () => {
    m.openFile.mockRejectedValueOnce({
      kind: "SCHEMA_INVALID",
      errors: [{ path: "", code: "enum", message: "m", params: { allowed: ["a", "b"], n: 3 } }],
    });
    await fa.openPath("/bad.json");
    expect(useFileUi.getState().schemaError?.issues[0]?.params).toEqual({ allowed: '["a","b"]', n: 3 });
  });

  it("m5: closeSaving hides the confirmation, ignores re-entry and destroys after saving", async () => {
    await openSample();
    st().dispatch({ type: "addTask", afterId: null });
    useFileUi.setState({ unsavedClose: true });
    m.saveFile.mockResolvedValueOnce(undefined);
    await Promise.all([fa.closeSaving(), fa.closeSaving()]);
    expect(m.saveFile).toHaveBeenCalledTimes(1);
    expect(m.destroyWindow).toHaveBeenCalledTimes(1);
    expect(useFileUi.getState().unsavedClose).toBe(false);
  });

  it("m5: save failing with a schema error shows only the error dialog", async () => {
    await openSample();
    st().dispatch({ type: "addTask", afterId: null });
    useFileUi.setState({ unsavedClose: true });
    m.saveFile.mockRejectedValueOnce({ kind: "SCHEMA_INVALID", errors: [{ path: "/x", code: "type", message: "m" }] });
    await fa.closeSaving();
    expect(useFileUi.getState().unsavedClose).toBe(false);
    expect(useFileUi.getState().schemaError).not.toBeNull();
    expect(m.destroyWindow).not.toHaveBeenCalled();
  });

  it("m5: cancelling Save As returns to the confirmation", async () => {
    await fa.newDocument();
    st().dispatch({ type: "addTask", afterId: null });
    m.saveDialog.mockResolvedValueOnce(null);
    await fa.closeSaving();
    expect(useFileUi.getState().unsavedClose).toBe(true);
    expect(m.destroyWindow).not.toHaveBeenCalled();
  });

  describe("menu actions", () => {
    it("dispatches new / open / save / saveAs / exportPdf", async () => {
      await openSample();
      m.openDialog.mockResolvedValueOnce(null);
      fa.handleMenuAction("open");
      expect(m.openDialog).toHaveBeenCalled();
      fa.handleMenuAction("new");
      await vi.waitFor(() => expect(m.newWindow).toHaveBeenCalledWith(null, true));
      m.saveFile.mockResolvedValueOnce(undefined);
      fa.handleMenuAction("save");
      await vi.waitFor(() => expect(m.saveFile).toHaveBeenCalled());
      m.saveDialog.mockResolvedValueOnce(null);
      fa.handleMenuAction("saveAs");
      await vi.waitFor(() => expect(m.saveDialog).toHaveBeenCalled());
      fa.handleMenuAction("exportPdf");
      await vi.waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
    });

    it("undo / redo go to the store when no text field is focused", async () => {
      await openSample();
      const before = st().doc;
      st().dispatch({ type: "addTask", afterId: null });
      fa.handleMenuAction("undo");
      expect(st().doc).toEqual(before);
      fa.handleMenuAction("redo");
      expect(st().undoStack).toHaveLength(1);
    });

    it("M3: ignored while dragging", async () => {
      await openSample();
      dragging = true;
      fa.handleMenuAction("save");
      fa.handleMenuAction("new");
      expect(m.saveFile).not.toHaveBeenCalled();
      expect(m.newWindow).not.toHaveBeenCalled();
    });

    it("ignored while a modal is open", async () => {
      await openSample();
      modal = true;
      fa.handleMenuAction("save");
      expect(m.saveFile).not.toHaveBeenCalled();
    });
  });

  describe("drag and drop", () => {
    it("drop opens the first .json and ignores other files", async () => {
      m.openFile.mockResolvedValueOnce({ document: fresh(), warnings: [] });
      fa.handleDrop(["/a.txt", "/b.JSON", "/c.json"]);
      await vi.waitFor(() => expect(m.openFile).toHaveBeenCalledWith("/b.JSON"));
      expect(m.openFile).toHaveBeenCalledTimes(1);
    });

    it("drop without a .json does nothing", () => {
      fa.handleDrop(["/a.txt"]);
      expect(m.focusWindowWithFile).not.toHaveBeenCalled();
      expect(m.openFile).not.toHaveBeenCalled();
    });

    it("drop is ignored while a modal is open", () => {
      modal = true;
      fa.handleDrop(["/a.json"]);
      expect(m.focusWindowWithFile).not.toHaveBeenCalled();
    });

    it("the drop frame shows only for .json and only changes on enter / leave", () => {
      fa.handleDragEvent("enter", ["/a.txt"]);
      expect(useFileUi.getState().dragOver).toBe(false);
      fa.handleDragEvent("enter", ["/a.json"]);
      expect(useFileUi.getState().dragOver).toBe(true);
      fa.handleDragEvent("over", []);
      expect(useFileUi.getState().dragOver).toBe(true);
      fa.handleDragEvent("leave", []);
      expect(useFileUi.getState().dragOver).toBe(false);
    });
  });

  it("window title", () => {
    expect(fa.windowTitle("/a/b.json", true, true)).toBe("● b.json — json-gantt");
    expect(fa.windowTitle(null, true, false)).toContain("json-gantt");
    expect(fa.windowTitle(null, false, false)).toBe("json-gantt");
  });
});
