import { describe, expect, it } from "vitest";
import { hitMode, IDLE, isActive, reduce, type DragEffect, type DragEvent, type DragState } from "../dragMachine";

const down = (over: Partial<Extract<DragEvent, { type: "pointerdown" }>> = {}): DragEvent => ({
  type: "pointerdown",
  taskId: "t1",
  mode: "move",
  x: 100,
  y: 10,
  dayWidth: 68,
  baseStart: "2025-05-26",
  baseEnd: "2025-05-28",
  ...over,
});
const move = (x: number, y = 10, targetId?: string | null): DragEvent => ({ type: "pointermove", x, y, targetId });
const up = (x: number, y = 10, targetId?: string | null): DragEvent => ({ type: "pointerup", x, y, targetId });

/** Run events through the machine; returns final state and every effect. */
function run(events: DragEvent[], state: DragState = IDLE): { state: DragState; effects: DragEffect[] } {
  const effects: DragEffect[] = [];
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    effects.push(r.effect);
  }
  return { state, effects };
}
const types = (fx: DragEffect[]) => fx.map((f) => f.type);

describe("dragMachine move", () => {
  it("pointerdown selects the task and enters pressed", () => {
    const r = reduce(IDLE, down());
    expect(r.state.phase).toBe("pressed");
    expect(r.effect).toEqual({ type: "select", taskId: "t1" });
  });

  it("down -> move(2px) -> up emits no command", () => {
    const { effects, state } = run([down(), move(102), up(102)]);
    expect(types(effects)).toEqual(["select", "none", "none"]);
    expect(state.phase).toBe("idle");
  });

  it("move(70px) at day zoom previews moveTask delta 1; up commits exactly once", () => {
    const { effects, state } = run([down(), move(170), up(170)]);
    expect(effects[1]).toEqual({ type: "preview", cmd: { type: "moveTask", id: "t1", deltaDays: 1 } });
    expect(effects[2]).toEqual({ type: "commit", cmd: { type: "moveTask", id: "t1", deltaDays: 1 } });
    expect(effects.filter((e) => e.type === "commit")).toHaveLength(1);
    expect(state.phase).toBe("idle");
  });

  it("only previews when the day delta changes", () => {
    const { effects } = run([down(), move(170), move(172), move(175), move(240)]);
    expect(types(effects)).toEqual(["select", "preview", "none", "none", "preview"]);
    expect(effects[4]).toEqual({ type: "preview", cmd: { type: "moveTask", id: "t1", deltaDays: 2 } });
  });

  it("negative delta rounds to the nearest day", () => {
    const { effects } = run([down(), move(100 - 40)]);
    expect(effects[1]).toEqual({ type: "preview", cmd: { type: "moveTask", id: "t1", deltaDays: -1 } });
  });

  it("dragging back to delta 0 previews 0 and up commits nothing", () => {
    const { effects } = run([down(), move(170), move(100), up(100)]);
    expect(effects[2]).toEqual({ type: "preview", cmd: { type: "moveTask", id: "t1", deltaDays: 0 } });
    expect(effects[3]).toEqual({ type: "clear" });
  });

  it("Escape while dragging dispatches nothing and clears the preview", () => {
    const { effects, state } = run([down(), move(170), { type: "cancel" }, up(170)]);
    expect(effects[2]).toEqual({ type: "clear" });
    expect(types(effects)).not.toContain("commit");
    expect(state.phase).toBe("idle");
  });

  it("Escape while pressed is a no-op", () => {
    const { effects } = run([down(), { type: "cancel" }]);
    expect(effects[1]).toEqual({ type: "none" });
  });

  it("week zoom uses its own day width", () => {
    const { effects } = run([down({ dayWidth: 20 }), move(100 + 45)]);
    expect(effects[1]).toEqual({ type: "preview", cmd: { type: "moveTask", id: "t1", deltaDays: 2 } });
  });

  it("events while idle are ignored", () => {
    expect(reduce(IDLE, move(10)).effect).toEqual({ type: "none" });
    expect(reduce(IDLE, up(10)).effect).toEqual({ type: "none" });
  });

  it("isActive is true only past the threshold", () => {
    expect(isActive(run([down(), move(101)]).state)).toBe(false);
    expect(isActive(run([down(), move(110)]).state)).toBe(true);
  });
});

describe("dragMachine resize", () => {
  it("resizeEnd -> resizeTaskEnd with base end + delta", () => {
    const { effects } = run([down({ mode: "resizeEnd" }), move(170), up(170)]);
    expect(effects[1]).toEqual({ type: "preview", cmd: { type: "resizeTaskEnd", id: "t1", newEnd: "2025-05-29" } });
    expect(effects[2]).toEqual({ type: "commit", cmd: { type: "resizeTaskEnd", id: "t1", newEnd: "2025-05-29" } });
  });

  it("resizeStart -> resizeTaskStart with base start + delta", () => {
    const { effects } = run([down({ mode: "resizeStart" }), move(100 - 70)]);
    expect(effects[1]).toEqual({ type: "preview", cmd: { type: "resizeTaskStart", id: "t1", newStart: "2025-05-25" } });
  });
});

describe("dragMachine link", () => {
  const linkDown = down({ mode: "link" });

  it("a plain click on the handle does nothing", () => {
    const { effects } = run([linkDown, move(101), up(101)]);
    expect(types(effects)).toEqual(["select", "none", "none"]);
  });

  it("moving past the threshold shows the link; up on another bar adds the dependency", () => {
    const { effects, state } = run([linkDown, move(150, 40, "t2"), up(150, 40, "t2")]);
    expect(effects[1]).toEqual({ type: "link", sourceId: "t1", x: 150, y: 40, targetId: "t2" });
    expect(effects[2]).toEqual({ type: "commitLink", succId: "t2", predId: "t1" });
    expect(state.phase).toBe("idle");
  });

  it("dropping on the source itself or empty space commits nothing", () => {
    expect(run([linkDown, move(150, 40, "t1"), up(150, 40, "t1")]).effects[2]).toEqual({ type: "clear" });
    expect(run([linkDown, move(150, 40), up(150, 40, null)]).effects[2]).toEqual({ type: "clear" });
  });

  it("Escape cancels the link", () => {
    const { effects } = run([linkDown, move(150, 40, "t2"), { type: "cancel" }]);
    expect(effects[2]).toEqual({ type: "clear" });
  });

  it("vertical travel alone starts the link", () => {
    expect(run([linkDown, move(100, 30)]).effects[1].type).toBe("link");
  });
});

describe("hitMode", () => {
  it("leaf bar edges", () => {
    expect(hitMode("leaf", 100, 3)).toBe("resizeStart");
    expect(hitMode("leaf", 100, 50)).toBe("move");
    expect(hitMode("leaf", 100, 96)).toBe("resizeEnd");
  });
  it("narrow leaf bar only resizes at the end", () => {
    expect(hitMode("leaf", 20, 2)).toBe("move");
    expect(hitMode("leaf", 20, 17)).toBe("resizeEnd");
  });
  it("summary bars always move", () => {
    expect(hitMode("summary", 100, 1)).toBe("move");
    expect(hitMode("summary", 100, 99)).toBe("move");
  });
});
