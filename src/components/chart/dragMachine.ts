// Pure drag state machine (03 section 6.2). No DOM, no store: the host (useDrag)
// feeds events in and performs the returned effect.
import { addDays } from "../../model/date";
import type { IsoDate } from "../../model/types";
import type { Command } from "../../engine";
import { EDGE_HIT_PX } from "./constants";

export type DragMode = "move" | "resizeStart" | "resizeEnd" | "link";

/** Pointer travel (px) before a press turns into a drag. */
export const DRAG_THRESHOLD_PX = 3;

export type DragState =
  | { phase: "idle" }
  | {
      phase: "pressed";
      taskId: string;
      mode: DragMode;
      startX: number;
      startY: number;
      dayWidth: number;
      baseStart: IsoDate;
      baseEnd: IsoDate;
    }
  | {
      phase: "dragging";
      taskId: string;
      mode: Exclude<DragMode, "link">;
      startX: number;
      dayWidth: number;
      baseStart: IsoDate;
      baseEnd: IsoDate;
      delta: number;
    }
  | { phase: "linking"; taskId: string; startX: number; startY: number; targetId: string | null };

export type DragEvent =
  | {
      type: "pointerdown";
      taskId: string;
      mode: DragMode;
      /** Content coordinates. */
      x: number;
      y: number;
      dayWidth: number;
      baseStart: IsoDate;
      baseEnd: IsoDate;
    }
  | { type: "pointermove"; x: number; y: number; targetId?: string | null }
  | { type: "pointerup"; x: number; y: number; targetId?: string | null }
  /** Escape, pointercancel or lostpointercapture. */
  | { type: "cancel" };

export type DragEffect =
  | { type: "none" }
  | { type: "select"; taskId: string }
  /** Show `cmd` applied to the base document as a preview (not committed). */
  | { type: "preview"; cmd: Command }
  /** Dispatch `cmd` (exactly one Undo unit) and clear the preview. */
  | { type: "commit"; cmd: Command }
  /** Clear the preview; nothing is committed. */
  | { type: "clear" }
  | { type: "link"; sourceId: string; x: number; y: number; targetId: string | null }
  | { type: "commitLink"; succId: string; predId: string };

export interface DragResult {
  state: DragState;
  effect: DragEffect;
}

export const IDLE: DragState = { phase: "idle" };
const NONE: DragEffect = { type: "none" };

function commandFor(
  mode: Exclude<DragMode, "link">,
  taskId: string,
  delta: number,
  baseStart: IsoDate,
  baseEnd: IsoDate,
): Command {
  switch (mode) {
    case "move":
      return { type: "moveTask", id: taskId, deltaDays: delta };
    case "resizeEnd":
      return { type: "resizeTaskEnd", id: taskId, newEnd: addDays(baseEnd, delta) };
    case "resizeStart":
      return { type: "resizeTaskStart", id: taskId, newStart: addDays(baseStart, delta) };
  }
}

export function reduce(state: DragState, event: DragEvent): DragResult {
  if (event.type === "pointerdown") {
    // A new press always restarts the machine.
    return {
      state: {
        phase: "pressed",
        taskId: event.taskId,
        mode: event.mode,
        startX: event.x,
        startY: event.y,
        dayWidth: event.dayWidth,
        baseStart: event.baseStart,
        baseEnd: event.baseEnd,
      },
      effect: { type: "select", taskId: event.taskId },
    };
  }

  switch (state.phase) {
    case "idle":
      return { state, effect: NONE };

    case "pressed": {
      if (event.type === "cancel") return { state: IDLE, effect: NONE };
      if (event.type === "pointerup") return { state: IDLE, effect: NONE }; // plain click
      const dx = event.x - state.startX;
      const dy = event.y - state.startY;
      if (state.mode === "link") {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return { state, effect: NONE };
        const targetId = event.targetId && event.targetId !== state.taskId ? event.targetId : null;
        return {
          state: { phase: "linking", taskId: state.taskId, startX: state.startX, startY: state.startY, targetId },
          effect: { type: "link", sourceId: state.taskId, x: event.x, y: event.y, targetId },
        };
      }
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return { state, effect: NONE };
      const next: DragState = {
        phase: "dragging",
        taskId: state.taskId,
        mode: state.mode,
        startX: state.startX,
        dayWidth: state.dayWidth,
        baseStart: state.baseStart,
        baseEnd: state.baseEnd,
        delta: 0,
      };
      // Re-run the same move against the dragging state so the first frame can already preview.
      return reduce(next, event);
    }

    case "dragging": {
      if (event.type === "cancel") return { state: IDLE, effect: { type: "clear" } };
      const delta = Math.round((event.x - state.startX) / state.dayWidth) || 0;
      if (event.type === "pointerup") {
        if (delta === 0) return { state: IDLE, effect: { type: "clear" } };
        return {
          state: IDLE,
          effect: {
            type: "commit",
            cmd: commandFor(state.mode, state.taskId, delta, state.baseStart, state.baseEnd),
          },
        };
      }
      if (delta === state.delta) return { state, effect: NONE };
      return {
        state: { ...state, delta },
        effect: {
          type: "preview",
          cmd: commandFor(state.mode, state.taskId, delta, state.baseStart, state.baseEnd),
        },
      };
    }

    case "linking": {
      if (event.type === "cancel") return { state: IDLE, effect: { type: "clear" } };
      const targetId = event.targetId && event.targetId !== state.taskId ? event.targetId : null;
      if (event.type === "pointerup") {
        if (targetId === null) return { state: IDLE, effect: { type: "clear" } };
        return { state: IDLE, effect: { type: "commitLink", succId: targetId, predId: state.taskId } };
      }
      return {
        state: { ...state, targetId },
        effect: { type: "link", sourceId: state.taskId, x: event.x, y: event.y, targetId },
      };
    }
  }
}

/** Is a drag in progress (past the threshold)? */
export function isActive(state: DragState): boolean {
  return state.phase === "dragging" || state.phase === "linking";
}

/**
 * Hit mode inside a bar (03 section 6.1). `localX` is relative to the bar's left edge.
 * Parent (summary) bars always move.
 */
export function hitMode(kind: "leaf" | "summary", width: number, localX: number): Exclude<DragMode, "link"> {
  if (kind === "summary") return "move";
  if (width >= 24) {
    if (localX <= EDGE_HIT_PX) return "resizeStart";
    if (localX >= width - EDGE_HIT_PX) return "resizeEnd";
    return "move";
  }
  return localX >= width - 4 ? "resizeEnd" : "move";
}
