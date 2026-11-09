import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { canAddDependency, executeCommand, formatDuration, getDerived } from "../../engine";
import { todayIso } from "../../model/date";
import { newId } from "../../model/id";
import type { IsoDate } from "../../model/types";
import { useAppStore } from "../../store/appStore";
import { calendarOf, derivedOf } from "../../store/selectors";
import { GRID_WIDTH, ROW_HEIGHT } from "./constants";
import { hitMode, isActive, IDLE, reduce, type DragEvent, type DragMode, type DragState } from "./dragMachine";
import type { Layout } from "./layout";
import { runCommand } from "../actions";
import { showCommandError } from "../uiStore";

const AUTOSCROLL_EDGE = 40;
const AUTOSCROLL_STEP = 10;

let dragging = false;
/**
 * True from pointerdown on a bar until the gesture ends (also while only pressed, before the drag
 * threshold). Keyboard shortcuts are ignored then so the document cannot change under the drag.
 */
export const isDragActive = (): boolean => dragging;

export interface LinkOverlay {
  /** Timeline (svg) coordinates. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  targetId: string | null;
  valid: boolean;
}
export interface TooltipOverlay {
  /** Viewport coordinates of the pointer. */
  x: number;
  y: number;
  text: string;
}
export interface DragOverlay {
  link: LinkOverlay | null;
  tooltip: TooltipOverlay | null;
}

interface Options {
  layoutRef: RefObject<Layout | null>;
  scrollRef: RefObject<HTMLElement | null>;
}

/**
 * Feeds pointer events into dragMachine and performs its effects (03 section 6).
 * Returns the pointerdown handler for the timeline svg, the range to freeze the layout to
 * while pressed/dragging, and overlay data (link line, tooltip).
 */
export function useDrag({ layoutRef, scrollRef }: Options) {
  const [frozenRange, setFrozenRange] = useState<Layout["range"] | null>(null);
  const [overlay, setOverlay] = useState<DragOverlay>({ link: null, tooltip: null });
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      const layout = layoutRef.current;
      const svg = e.currentTarget;
      const targetEl = e.target instanceof Element ? e.target : null;
      const group = targetEl?.closest("[data-task-id]");
      const taskId = group?.getAttribute("data-task-id");
      if (!layout || !group || !taskId) return;
      const state0 = useAppStore.getState();
      const baseDoc = state0.doc;
      if (baseDoc === null || state0.preview !== null) return;
      const bar = layout.bars.find((b) => b.taskId === taskId);
      const dt = getDerived(derivedOf(baseDoc), taskId);
      if (!bar || !dt) return;

      const toContent = (clientX: number, clientY: number) => {
        const r = svg.getBoundingClientRect();
        return { x: clientX - r.left, y: clientY - r.top };
      };
      const p0 = toContent(e.clientX, e.clientY);
      const isHandle = targetEl?.closest("[data-link-handle]") != null;
      const mode: DragMode = isHandle ? "link" : hitMode(bar.kind, bar.w, p0.x - bar.x);

      cleanupRef.current?.();
      const ctx = { today: todayIso(), newId, defaultTaskName: "" };
      const range = layout.range;
      const dayWidth = layout.dayWidth;
      let state: DragState = IDLE;
      let lastClient = { x: e.clientX, y: e.clientY };
      let raf = 0;
      let cursorSet = false;
      let tipDirty = false;

      const cursorFor = (m: DragMode) => (m === "move" ? "grabbing" : m === "link" ? "crosshair" : "ew-resize");

      const setTooltip = (client: { x: number; y: number }) => {
        const prev = useAppStore.getState().preview;
        if (!prev) return;
        const d = getDerived(derivedOf(prev), taskId);
        if (!d) return;
        const md = (s: IsoDate) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
        const text = `${md(d.start)} – ${md(d.end)} (${formatDuration(d.durationDays, calendarOf(prev))})`;
        setOverlay((o) => ({ ...o, tooltip: { x: client.x, y: client.y, text } }));
      };

      const perform = (ev: DragEvent, client: { x: number; y: number }) => {
        // The document changed under the gesture (undo, menu action, ...): abandon it.
        if (ev.type !== "cancel" && useAppStore.getState().doc !== baseDoc) {
          finish();
          return;
        }
        const res = reduce(state, ev);
        state = res.state;
        if (isActive(state) && !cursorSet) {
          cursorSet = true;
          document.body.style.cursor = cursorFor(mode);
        }
        const fx = res.effect;
        switch (fx.type) {
          case "none":
            break;
          case "select":
            useAppStore.getState().select(fx.taskId);
            break;
          case "preview": {
            const r = executeCommand(baseDoc, fx.cmd, ctx);
            if (r.ok) {
              useAppStore.getState().setPreview(r.doc);
              setTooltip(client);
            }
            break;
          }
          case "commit": {
            finish();
            runCommand(fx.cmd);
            break;
          }
          case "clear":
            finish();
            break;
          case "link": {
            const target = fx.targetId;
            const valid = target !== null && canAddDependency(baseDoc, target, fx.sourceId).ok;
            setOverlay({
              tooltip: null,
              link: {
                fromX: bar.x + bar.w,
                fromY: bar.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2,
                toX: fx.x,
                toY: fx.y,
                targetId: target,
                valid,
              },
            });
            break;
          }
          case "commitLink": {
            finish();
            const check = canAddDependency(baseDoc, fx.succId, fx.predId);
            if (check.ok) runCommand({ type: "addDependency", succId: fx.succId, predId: fx.predId });
            else showCommandError({ ok: false, code: check.code });
            break;
          }
        }
        if (state.phase === "idle" && fx.type === "none") finish();
      };

      const targetAt = (clientX: number, clientY: number): string | null => {
        const el = document.elementFromPoint(clientX, clientY);
        return el?.closest("[data-task-id]")?.getAttribute("data-task-id") ?? null;
      };

      const moveEvent = (clientX: number, clientY: number): DragEvent => {
        const p = toContent(clientX, clientY);
        return { type: "pointermove", x: p.x, y: p.y, targetId: mode === "link" ? targetAt(clientX, clientY) : null };
      };

      const onMove = (ev: PointerEvent) => {
        // The button was released outside the window (pointerup never arrived): treat as release.
        if (ev.buttons === 0) {
          onUp(ev);
          return;
        }
        lastClient = { x: ev.clientX, y: ev.clientY };
        tipDirty = true;
        perform(moveEvent(ev.clientX, ev.clientY), lastClient);
      };
      const onUp = (ev: PointerEvent) => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        const p = toContent(ev.clientX, ev.clientY);
        perform(
          { type: "pointerup", x: p.x, y: p.y, targetId: mode === "link" ? targetAt(ev.clientX, ev.clientY) : null },
          { x: ev.clientX, y: ev.clientY },
        );
        finish();
      };
      const onCancel = () => {
        perform({ type: "cancel" }, lastClient);
        finish();
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          onCancel();
        }
      };

      // Auto scroll near the left/right edge of the visible timeline; also moves the tooltip
      // with the pointer (once per frame).
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (tipDirty) {
          tipDirty = false;
          const { x, y } = lastClient;
          setOverlay((o) => (o.tooltip ? { ...o, tooltip: { ...o.tooltip, x, y } } : o));
        }
        const sc = scrollRef.current;
        if (!sc || !isActive(state) || mode === "link") return;
        const r = sc.getBoundingClientRect();
        const left = r.left + GRID_WIDTH;
        let dx = 0;
        if (lastClient.x < left + AUTOSCROLL_EDGE) dx = -AUTOSCROLL_STEP;
        else if (lastClient.x > r.right - AUTOSCROLL_EDGE) dx = AUTOSCROLL_STEP;
        if (dx === 0) return;
        const before = sc.scrollLeft;
        sc.scrollLeft = before + dx;
        if (sc.scrollLeft !== before) perform(moveEvent(lastClient.x, lastClient.y), lastClient);
      };

      let finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onCancel);
        svg.removeEventListener("lostpointercapture", onCancel);
        try {
          if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
        } catch {
          /* not captured */
        }
        if (raf) cancelAnimationFrame(raf);
        useAppStore.getState().clearPreview();
        dragging = false;
        document.body.style.cursor = "";
        setOverlay({ link: null, tooltip: null });
        setFrozenRange(null);
        cleanupRef.current = null;
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onCancel);
      try {
        // Keep receiving events when the pointer leaves the window / is released elsewhere.
        svg.setPointerCapture(e.pointerId);
        svg.addEventListener("lostpointercapture", onCancel);
      } catch {
        /* synthetic events have no active pointer */
      }
      dragging = true;
      cleanupRef.current = finish;
      raf = requestAnimationFrame(tick);
      setFrozenRange(range);

      perform(
        {
          type: "pointerdown",
          taskId,
          mode,
          x: p0.x,
          y: p0.y,
          dayWidth,
          baseStart: dt.start,
          baseEnd: dt.end,
        },
        lastClient,
      );
    },
    [layoutRef, scrollRef],
  );

  /** Hover cursor: grab / ew-resize / crosshair over bars (03 section 6.1). */
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (dragging) return;
      const svg = e.currentTarget;
      const layout = layoutRef.current;
      const el = e.target instanceof Element ? e.target : null;
      const taskId = el?.closest("[data-task-id]")?.getAttribute("data-task-id");
      let cursor = "default";
      if (layout && taskId) {
        if (el?.closest("[data-link-handle]")) cursor = "crosshair";
        else {
          const bar = layout.bars.find((b) => b.taskId === taskId);
          if (bar) {
            const mode = hitMode(bar.kind, bar.w, e.clientX - svg.getBoundingClientRect().left - bar.x);
            cursor = mode === "move" ? "grab" : "ew-resize";
          }
        }
      }
      if (svg.style.cursor !== cursor) svg.style.cursor = cursor;
    },
    [layoutRef],
  );

  return { onPointerDown, onPointerMove, frozenRange, overlay };
}
