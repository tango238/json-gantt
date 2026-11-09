import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../../../schema/examples/sample.json";
import { loadDocument } from "../../engine";
import type { GanttDocument } from "../../model/types";
import { useAppStore } from "../../store/appStore";
import { isDirty } from "../../store/selectors";
import type { AiRunResult } from "../../tauri/types";
import { fixtureLines } from "./fixtures";

vi.mock("../../tauri/isTauri", () => ({ isTauri: () => true }));
vi.mock("../../tauri/events", () => ({ onAiEvent: vi.fn(async () => () => undefined) }));
vi.mock("../../export/exportPdf", () => ({ exportPdf: vi.fn() }));
let dragging = false;
vi.mock("../../components/chart/useDrag", () => ({ isDragActive: () => dragging }));
vi.mock("../../tauri/api", () => ({
  aiLocate: vi.fn(),
  aiRun: vi.fn(),
  aiStop: vi.fn(async () => undefined),
  aiReset: vi.fn(async () => undefined),
  aiSetClaudePath: vi.fn(),
  saveFile: vi.fn(),
}));

import * as api from "../../tauri/api";
import * as actions from "../aiActions";
import { resetAiStore, useAiStore } from "../aiStore";

const m = vi.mocked(api);
const app = () => useAppStore.getState();
const ai = () => useAiStore.getState();
const RESULT_LINE = fixtureLines("probe").slice(-1)[0]!;
const SID = "bdd5bdc5-8d12-4181-b34a-e70717bf6318";

const loaded = (() => {
  const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
  if (!r.ok) throw new Error("sample");
  return r.doc;
})();

function openDoc(path = "/a/sample.json"): GanttDocument {
  app().loadDocument(path, structuredClone(loaded));
  resetAiStore();
  vi.clearAllMocks();
  m.aiLocate.mockResolvedValue({ claudePath: "/bin/claude", dir: "/tmp/g", ganttPath: "/tmp/g/gantt.json", schemaPath: "/tmp/g/schema.json" });
  return app().doc!;
}

function runResult(over: Partial<AiRunResult> = {}): AiRunResult {
  return {
    runId: "",
    exit: { code: 0, stopped: false, timedOut: false },
    stderrTail: "",
    lastResultLine: RESULT_LINE,
    file: { status: "unchanged" },
    ...over,
  };
}
/** Renamed copy of the first task (what the AI "wrote"). */
function renamed(base: GanttDocument, name = "AI renamed"): GanttDocument {
  const d = structuredClone(base);
  d.tasks[0]!.name = name;
  return d;
}
const changed = (doc: GanttDocument) => runResult({ file: { status: "changed", document: doc, warnings: [] } });
/** aiRun that emits the probe events (session id etc.) and then resolves with `res`. */
function mockRun(res: AiRunResult | (() => AiRunResult | Promise<AiRunResult>), emit = true) {
  m.aiRun.mockImplementationOnce(async (args) => {
    if (emit) for (const line of fixtureLines("probe")) actions.handleAiEvent({ runId: args.runId, line });
    const r = typeof res === "function" ? await res() : res;
    return { ...r, runId: args.runId };
  });
}
/** Waits until the nth aiRun call (the run is registered in the backend). */
const started = (n: number) => vi.waitFor(() => expect(m.aiRun).toHaveBeenCalledTimes(n));
const cards = () => ai().messages.filter((x) => x.kind === "result") as Extract<ReturnType<typeof ai>["messages"][number], { kind: "result" }>[];
const lastCard = () => cards().slice(-1)[0]!;

let dispose: () => void;
beforeEach(() => {
  dragging = false;
  useAppStore.setState({ doc: null, filePath: null, undoStack: [], redoStack: [], loadCount: 0, selectedId: null });
  dispose = actions.initAiActions();
});
afterEach(() => dispose());

describe("aiActions", () => {
  it("A1: import is one undo step on top of an unsaved edit", async () => {
    const base = openDoc();
    const firstId = base.tasks[0]!.id;
    expect(app().dispatch({ type: "setName", id: firstId, name: "User edit" }).ok).toBe(true);
    const afterEdit = app().doc!;
    const stack = app().undoStack.length;
    mockRun(changed(renamed(afterEdit)));
    await actions.send("rename");
    expect(app().undoStack.length).toBe(stack + 1);
    expect(app().doc!.tasks[0]!.name).toBe("AI renamed");
    app().undo();
    expect(app().doc).toEqual(afterEdit);
    expect(isDirty(app())).toBe(true);
    app().undo();
    expect(app().doc).toEqual(base);
  });

  it("A2: importing marks the document dirty and never saves", async () => {
    const base = openDoc();
    expect(isDirty(app())).toBe(false);
    mockRun(changed(renamed(base)));
    await actions.send("rename");
    expect(isDirty(app())).toBe(true);
    expect(m.saveFile).not.toHaveBeenCalled();
  });

  it("A3: a successful turn with changes is applied automatically with a summary", async () => {
    const base = openDoc();
    mockRun(changed(renamed(base)));
    await actions.send("rename");
    const card = lastCard();
    expect(card.outcome).toBe("applied");
    expect(card.detail.summary).toMatchObject({ tasksChanged: 1, tasksAdded: 0 });
    expect(card.detail.undoId).toBe(app().undoStack.slice(-1)[0]!.id);
    expect(card.detail).toMatchObject({ durationMs: 7628, numTurns: 3, permissionDenials: 0 });
    expect(ai().status).toBe("idle");
    expect(ai().runId).toBeNull();
    expect(ai().sessionId).toBe(SID);
    expect(ai().messages.map((x) => x.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant", "result"]);
    // undo button logic
    expect(actions.canUndoTurn(card.detail.undoId)).toBe(true);
    expect(actions.undoTurn(card.detail.undoId)).toBe(true);
    expect(actions.canUndoTurn(card.detail.undoId)).toBe(false);
    expect(actions.undoTurn(undefined)).toBe(false);
    // arguments passed to the backend
    const args = m.aiRun.mock.calls[0]![0];
    expect(args.resumeSessionId).toBeNull();
    expect(args.document).toBe(base);
    expect(args.appendSystemPrompt).toContain("/tmp/g/gantt.json");
    expect(args.prompt).toContain("[ユーザーの依頼]\nrename");
  });

  it("A3b: the result line in the return value is used when no event arrived; same content is noChange", async () => {
    const base = openDoc();
    mockRun(changed(structuredClone(base)), false);
    await actions.send("nothing");
    expect(lastCard().outcome).toBe("noChange");
    expect(ai().sessionId).toBe(SID);
    expect(app().undoStack).toHaveLength(0);
  });

  it("A4: an edit made during the run makes the result pending; apply and discard", async () => {
    const base = openDoc();
    mockRun(() => {
      app().dispatch({ type: "setName", id: base.tasks[1]!.id, name: "during run" });
      return changed(renamed(base));
    });
    await actions.send("rename");
    expect(lastCard()).toMatchObject({ outcome: "pending", detail: { reason: "docChanged" } });
    expect(app().doc!.tasks[0]!.name).not.toBe("AI renamed");
    actions.applyPending();
    expect(lastCard().outcome).toBe("applied");
    expect(app().doc!.tasks[0]!.name).toBe("AI renamed");
    expect(app().doc!.tasks[1]!.name).toBe(base.tasks[1]!.name); // the concurrent edit was overwritten
    app().undo();
    expect(app().doc!.tasks[1]!.name).toBe("during run");

    // discard path
    const base2 = openDoc();
    mockRun(() => {
      app().dispatch({ type: "setName", id: base2.tasks[1]!.id, name: "during run" });
      return changed(renamed(base2));
    });
    await actions.send("rename");
    const before = app().doc;
    actions.discard();
    expect(app().doc).toBe(before);
    expect(lastCard().outcome).toBe("discarded");
    expect(ai().pendingNext).toBeNull();
    mockRun(runResult());
    await actions.send("again");
    expect(m.aiRun.mock.calls.slice(-1)[0]![0].prompt).toContain("前回の編集はユーザーが破棄しました。");
  });

  it("A5: stopped runs: changed -> pending(stopped), unchanged -> noChange", async () => {
    const base = openDoc();
    const stopped = { code: null, stopped: true, timedOut: false };
    mockRun({ ...changed(renamed(base)), exit: stopped, lastResultLine: null });
    await actions.send("x");
    expect(lastCard()).toMatchObject({ outcome: "pending", detail: { reason: "stopped" } });
    expect(app().undoStack).toHaveLength(0);

    mockRun({ ...runResult(), exit: stopped, lastResultLine: null });
    await actions.send("y"); // the previous pending is discarded implicitly
    expect(cards()[0]!.outcome).toBe("discarded");
    expect(lastCard()).toMatchObject({ outcome: "noChange", detail: { reason: "stopped" } });
  });

  it("A5b: timeouts and failed turns", async () => {
    const base = openDoc();
    mockRun({ ...changed(renamed(base)), exit: { code: null, stopped: false, timedOut: true } });
    await actions.send("x");
    expect(lastCard()).toMatchObject({ outcome: "pending", detail: { reason: "timeout" } });
    actions.discard();
    mockRun({ ...runResult(), exit: { code: 1, stopped: false, timedOut: false }, lastResultLine: null, stderrTail: "boom" }, false);
    await actions.send("y");
    expect(lastCard()).toMatchObject({ outcome: "failed", detail: { reason: "exitCode", exitCode: 1, stderrTail: "boom" } });
    mockRun({ ...runResult(), lastResultLine: fixtureLines("error-result")[0]! }, false);
    await actions.send("z");
    expect(lastCard()).toMatchObject({ outcome: "failed", detail: { reason: "turnError" } });
    mockRun({ ...changed(renamed(base)), lastResultLine: fixtureLines("error-result")[0]! }, false);
    await actions.send("w");
    expect(lastCard()).toMatchObject({ outcome: "pending", detail: { reason: "turnError" } });
  });

  it("A6: invalid results keep the document and carry the errors into the next prompt once", async () => {
    const base = openDoc();
    mockRun(
      runResult({
        file: { status: "invalid", error: { kind: "SCHEMA_INVALID", errors: [{ path: "/tasks/0/start", code: "FORMAT", message: "bad" }] } },
      }),
    );
    await actions.send("a");
    expect(lastCard()).toMatchObject({ outcome: "invalid", detail: { issues: [{ path: "/tasks/0/start", code: "FORMAT" }] } });
    expect(app().doc).toBe(base);

    // engine-level failure (duplicate ids)
    const dup = structuredClone(base);
    dup.tasks.push(structuredClone(dup.tasks[0]!));
    mockRun(changed(dup));
    await actions.send("b");
    expect(m.aiRun.mock.calls[1]![0].prompt).toContain("/tasks/0/start FORMAT");
    expect(lastCard()).toMatchObject({ outcome: "invalid" });
    expect(lastCard().detail.issues![0]!.code).toBe("DUPLICATE_ID");

    mockRun(runResult({ file: { status: "missing" } }));
    await actions.send("c");
    expect(m.aiRun.mock.calls[2]![0].prompt).toContain("DUPLICATE_ID");
    expect(lastCard().detail.issues).toEqual([{ code: "AI_FILE_MISSING", path: "" }]);

    mockRun(runResult());
    await actions.send("d");
    expect(m.aiRun.mock.calls[3]![0].prompt).toContain("AI_FILE_MISSING");
    mockRun(runResult());
    await actions.send("e");
    expect(m.aiRun.mock.calls[4]![0].prompt).not.toContain("前回の編集");
    expect(app().doc).toBe(base);
  });

  it("A7: loading another document during a run resets the conversation and drops the late result", async () => {
    const base = openDoc();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockRun(async () => {
      await gate;
      return changed(renamed(base));
    });
    const p = actions.send("x");
    await started(1);
    expect(ai().status).toBe("running");
    app().loadDocument("/b/other.json", structuredClone(loaded));
    expect(ai().messages).toMatchObject([{ kind: "notice", textKey: "ai.notice.documentChanged" }]);
    expect(ai().sessionId).toBeNull();
    expect(ai().status).toBe("idle");
    expect(m.aiReset).toHaveBeenCalled();
    const other = app().doc;
    release();
    await p;
    expect(app().doc).toBe(other);
    expect(app().undoStack).toHaveLength(0);
    expect(ai().messages).toHaveLength(1);
  });

  it("A8: reloading the same file stops the run, discards pending, keeps the session", async () => {
    const base = openDoc();
    // pending from a previous turn
    mockRun({ ...changed(renamed(base)), exit: { code: null, stopped: true, timedOut: false } });
    await actions.send("first");
    expect(lastCard().outcome).toBe("pending");
    const sid = ai().sessionId;
    expect(sid).toBe(SID);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockRun(async () => {
      await gate;
      return changed(renamed(base, "late"));
    });
    const p = actions.send("second");
    await started(2);
    expect(cards()[0]!.outcome).toBe("discarded"); // implicitly by the new send
    app().loadDocument("/a/sample.json", structuredClone(loaded));
    expect(m.aiStop).toHaveBeenCalledTimes(1);
    expect(ai().status).toBe("stopping");
    expect(ai().sessionId).toBe(sid);
    expect(ai().messages.slice(-1)[0]).toMatchObject({ kind: "notice", textKey: "ai.notice.reloaded" });
    release();
    await p;
    expect(ai().status).toBe("idle");
    expect(ai().sessionId).toBe(sid);
    expect(app().doc!.tasks[0]!.name).not.toBe("late");

    // pending discarded on reload
    mockRun({ ...changed(renamed(app().doc!)), exit: { code: null, stopped: true, timedOut: false } });
    await actions.send("third");
    expect(lastCard().outcome).toBe("pending");
    app().loadDocument("/a/sample.json", structuredClone(loaded));
    expect(lastCard().outcome).toBe("discarded");
    expect(ai().pendingNext).toBeNull();
    expect(m.aiStop).toHaveBeenCalledTimes(1); // not running: no stop
  });

  it("A9: the session id is resumed on the second turn and cleared by reset", async () => {
    openDoc();
    mockRun(runResult());
    await actions.send("one");
    mockRun(runResult());
    await actions.send("two");
    expect(m.aiRun.mock.calls[0]![0].resumeSessionId).toBeNull();
    expect(m.aiRun.mock.calls[1]![0].resumeSessionId).toBe(SID);
    actions.reset();
    expect(ai().sessionId).toBeNull();
    expect(ai().messages).toMatchObject([{ kind: "notice", textKey: "ai.notice.newSession" }]);
    mockRun(runResult());
    await actions.send("three");
    expect(m.aiRun.mock.calls[2]![0].resumeSessionId).toBeNull();
  });

  it("A10: AI_NOT_FOUND sets the pane error and returns to idle; setClaudePath clears it", async () => {
    openDoc();
    m.aiLocate.mockRejectedValueOnce({ kind: "AI_NOT_FOUND", searched: ["/x/claude"] });
    await actions.send("hi");
    expect(ai().error).toEqual({ kind: "AI_NOT_FOUND", searched: ["/x/claude"] });
    expect(ai().status).toBe("idle");
    expect(lastCard()).toMatchObject({ outcome: "failed", detail: { error: { kind: "AI_NOT_FOUND" } } });
    expect(m.aiRun).not.toHaveBeenCalled();

    m.aiSetClaudePath.mockRejectedValueOnce({ kind: "AI_NOT_FOUND", searched: ["/y"] });
    await actions.setClaudePath("/y");
    expect(ai().error).toMatchObject({ kind: "AI_NOT_FOUND", searched: ["/y"] });
    m.aiSetClaudePath.mockResolvedValueOnce("/ok/claude");
    await actions.setClaudePath("/ok/claude");
    expect(ai().error).toBeNull();

    // a generic AI error only produces a card
    m.aiRun.mockRejectedValueOnce({ kind: "AI", message: "busy" });
    await actions.send("again");
    expect(ai().error).toBeNull();
    expect(lastCard()).toMatchObject({ outcome: "failed", detail: { error: { kind: "AI", message: "busy" } } });
    actions.dismissError();
  });

  it("send guards, selection context and stop()", async () => {
    const base = openDoc();
    await actions.send("   ");
    expect(m.aiRun).not.toHaveBeenCalled();
    app().select(base.tasks[1]!.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockRun(async () => {
      await gate;
      return runResult();
    });
    const p = actions.send("go");
    await started(1);
    await actions.send("second while running"); // ignored
    expect(m.aiRun).toHaveBeenCalledTimes(1);
    expect(m.aiRun.mock.calls[0]![0].prompt).toContain(`選択中のタスク: #2 ${base.tasks[1]!.name}`);
    await actions.stop();
    expect(ai().status).toBe("stopping");
    await actions.stop(); // only while running
    expect(m.aiStop).toHaveBeenCalledTimes(1);
    release();
    await p;
    expect(ai().status).toBe("idle");
    await actions.stop();
    expect(m.aiStop).toHaveBeenCalledTimes(1);
    // events of other runs are dropped
    actions.handleAiEvent({ runId: "other", line: '{"type":"system","subtype":"init","session_id":"zzz","tools":[]}' });
    expect(ai().sessionId).toBe(SID);
  });

  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  };
  const TOOL_USE = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/g/gantt.json"}}]}}';
  const stoppedExit = { code: null, stopped: true, timedOut: false };

  it("A11: [Stop] while the session is being located never starts the run", async () => {
    openDoc();
    const g = gated();
    m.aiLocate.mockImplementationOnce(async () => {
      await g.gate;
      return { claudePath: "/bin/claude", dir: "/tmp/g", ganttPath: "/tmp/g/gantt.json", schemaPath: "/tmp/g/schema.json" };
    });
    const p = actions.send("x");
    await Promise.resolve();
    const runId = ai().runId;
    await actions.stop();
    expect(m.aiStop).toHaveBeenCalledWith(runId); // Rust remembers it if the run is not registered yet
    g.release();
    await p;
    expect(m.aiRun).not.toHaveBeenCalled();
    expect(lastCard()).toMatchObject({ outcome: "noChange", detail: { reason: "stopped" } });
    expect(ai().status).toBe("idle");
    expect(ai().runId).toBeNull();
  });

  it("A12: [Stop] pressed but the run still ended normally is treated as stopped", async () => {
    const base = openDoc();
    const g = gated();
    mockRun(async () => {
      await g.gate;
      return changed(renamed(base)); // exit.stopped === false
    });
    const p = actions.send("x");
    await started(1);
    await actions.stop();
    g.release();
    await p;
    expect(lastCard()).toMatchObject({ outcome: "pending", detail: { reason: "stopped" } });
    expect(app().doc!.tasks[0]!.name).not.toBe("AI renamed");

    openDoc();
    const g2 = gated();
    mockRun(async () => {
      await g2.gate;
      return runResult();
    });
    const p2 = actions.send("y");
    await started(1);
    await actions.stop();
    g2.release();
    await p2;
    expect(lastCard()).toMatchObject({ outcome: "noChange", detail: { reason: "stopped" } });
  });

  it("A13: an exception while handling the result still returns to idle", async () => {
    const base = openDoc();
    mockRun(changed(renamed(base)));
    const real = app().dispatch;
    useAppStore.setState({
      dispatch: () => {
        throw new Error("boom");
      },
    });
    try {
      await actions.send("x");
    } finally {
      useAppStore.setState({ dispatch: real });
    }
    expect(ai().status).toBe("idle");
    expect(ai().runId).toBeNull();
    expect(lastCard()).toMatchObject({ outcome: "failed", detail: { error: { kind: "INTERNAL", message: "boom" } } });
    // and the pane is usable again
    mockRun(runResult());
    await actions.send("again");
    expect(m.aiRun).toHaveBeenCalledTimes(2);
  });

  it("A14: send waits for a pending reset", async () => {
    openDoc();
    const g = gated();
    m.aiReset.mockImplementationOnce(async () => g.gate);
    void actions.reset();
    mockRun(runResult());
    const p = actions.send("x");
    await new Promise((r) => setTimeout(r, 10));
    expect(m.aiLocate).not.toHaveBeenCalled();
    g.release();
    await p;
    expect(m.aiLocate).toHaveBeenCalledTimes(1);
    expect(m.aiRun).toHaveBeenCalledTimes(1);
  });

  it("A15: tool rows still running when the turn ends are settled; a later successful locate clears the AI_NOT_FOUND error", async () => {
    openDoc();
    useAiStore.setState({ error: { kind: "AI_NOT_FOUND", searched: ["/x"] } });
    mockRun(
      () => {
        actions.handleAiEvent({ runId: ai().runId!, line: TOOL_USE });
        return { ...runResult({ lastResultLine: null }), exit: stoppedExit };
      },
      false,
    );
    await actions.send("x");
    expect(ai().error).toBeNull();
    const tool = ai().messages.find((x) => x.kind === "tool");
    expect(tool).toMatchObject({ state: "error" });
  });

  it("A16: a resume that fails before init forgets the session id", async () => {
    openDoc();
    mockRun(runResult());
    await actions.send("one");
    expect(ai().sessionId).toBe(SID);
    mockRun({ ...runResult({ lastResultLine: null }), exit: { code: 1, stopped: false, timedOut: false }, stderrTail: "No conversation found" }, false);
    await actions.send("two");
    expect(lastCard().outcome).toBe("failed");
    expect(ai().sessionId).toBeNull();
    expect(ai().messages.slice(-1)[0]).toMatchObject({ kind: "notice", textKey: "ai.notice.newSession" });
    mockRun(runResult());
    await actions.send("three");
    expect(m.aiRun.mock.calls[2]![0].resumeSessionId).toBeNull();
    // an ordinary failure after init keeps the session
    mockRun({ ...runResult({ lastResultLine: null }), exit: { code: 1, stopped: false, timedOut: false } });
    await actions.send("four");
    expect(ai().sessionId).toBe(SID);
  });

  it("A17: a drag in progress when the result arrives makes it pending", async () => {
    const base = openDoc();
    mockRun(() => {
      dragging = true;
      return changed(renamed(base));
    });
    await actions.send("x");
    expect(lastCard()).toMatchObject({ outcome: "pending", detail: { reason: "docChanged" } });
    expect(app().doc!.tasks[0]!.name).not.toBe("AI renamed");
  });

  it("A18: a change of `view` alone during the run is not a document change", async () => {
    const base = openDoc();
    mockRun(() => {
      useAppStore.setState({ doc: { ...app().doc!, view: undefined } as unknown as GanttDocument });
      return changed(renamed(base));
    });
    await actions.send("x");
    expect(lastCard().outcome).toBe("applied");
    expect(app().doc!.tasks[0]!.name).toBe("AI renamed");
  });

  it("applyPending / discard without a candidate do nothing", () => {
    openDoc();
    actions.applyPending();
    actions.discard();
    expect(app().undoStack).toHaveLength(0);
  });
});
