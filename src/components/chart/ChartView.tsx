import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { addDays, diffDays, todayIso } from "../../model/date";
import { idKey } from "../../model/id";
import { useAppStore } from "../../store/appStore";
import {
  displayDoc,
  selectDerived,
  selectViolations,
  selectVisibleRowIds,
  selectWorkCalendar,
  treeIndexOf,
} from "../../store/selectors";
import { COLORS, FONT_FAMILY, GRID_WIDTH, HEADER_HEIGHT, ROW_HEIGHT } from "./constants";
import { GridBody } from "./GridBody";
import { GridHeader } from "./GridHeader";
import { InlineEditor } from "./InlineEditor";
import type { Layout } from "./layout";
import { computeLayout, minTaskStart, xOfDate } from "./layout";
import { TimelineBody } from "./TimelineBody";
import { TimelineHeader } from "./TimelineHeader";
import { useDrag } from "./useDrag";
import "../../styles/chart.css";

/**
 * Read-only chart: a single scroll container holding a 2x2 CSS grid
 * (grid header / timeline header / grid body / timeline body), see 03 section 2.3.
 */
const scrollStyle = {
  fontFamily: FONT_FAMILY,
  color: COLORS.text,
  "--row-hover": COLORS.hoverRow,
} as CSSProperties;

export function ChartView() {
  const doc = useAppStore(displayDoc);
  const derived = useAppStore(selectDerived);
  const wc = useAppStore(selectWorkCalendar);
  const violations = useAppStore(selectViolations);
  const valueColumn = useAppStore((s) => s.valueColumn);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectedDependency = useAppStore((s) => s.selectedDependency);
  const loadCount = useAppStore((s) => s.loadCount);
  const rowIds = useAppStore(selectVisibleRowIds);
  const select = useAppStore((s) => s.select);
  const selectDependency = useAppStore((s) => s.selectDependency);
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed);
  const setValueColumn = useAppStore((s) => s.setValueColumn);
  const setEditing = useAppStore((s) => s.setEditing);

  // Follows the calendar date (checked once a minute) so the today line / ranges do not go stale.
  const [today, setToday] = useState(todayIso);
  useEffect(() => {
    const id = setInterval(() => {
      const now = todayIso();
      setToday((prev) => (prev === now ? prev : now));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const zoom = doc?.view?.zoom ?? "day";
  const collapsedIds = doc?.view?.collapsedTaskIds;
  const collapsed = useMemo(() => new Set(collapsedIds ?? []), [collapsedIds]);

  // The range stays fixed while pressing / dragging so the bars do not jump under the pointer.
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const drag = useDrag({ layoutRef, scrollRef });
  const frozenRange = drag.frozenRange;

  const layout = useMemo(() => {
    if (!doc || !derived || !wc) return null;
    return computeLayout(
      {
        doc,
        derived,
        wc,
        zoom,
        collapsed,
        valueColumn,
        ix: treeIndexOf(doc),
        violations,
        rowIds,
        ...(frozenRange ? { range: frozenRange } : {}),
      },
      today,
      layoutRef.current, // keeps unchanged rows / bars / arrows referentially stable (memo children)
    );
  }, [doc, derived, wc, zoom, collapsed, valueColumn, violations, rowIds, today, frozenRange]);
  layoutRef.current = layout;

  // Scroll position handling (03 section 8.3).
  const lastScrollLeft = useRef(0);
  const prev = useRef<{ loadCount: number; zoom: string; start: string; dayWidth: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !layout || !derived) return;
    const p = prev.current;
    if (p === null || p.loadCount !== loadCount) {
      // A document was (re)loaded: jump to the earliest task.
      el.scrollLeft = Math.max(0, xOfDate(layout, minTaskStart(derived, today)) - layout.dayWidth);
    } else if (p.zoom !== zoom) {
      const d = addDays(p.start, Math.floor(lastScrollLeft.current / p.dayWidth));
      el.scrollLeft = Math.max(0, xOfDate(layout, d));
    } else if (p.start !== layout.range.start) {
      // The displayed range changed (e.g. after a drag): keep the same dates under the viewport.
      el.scrollLeft = Math.max(0, el.scrollLeft + diffDays(layout.range.start, p.start) * layout.dayWidth);
    }
    lastScrollLeft.current = el.scrollLeft;
    prev.current = { loadCount, zoom, start: layout.range.start, dayWidth: layout.dayWidth };
  }, [layout, derived, loadCount, zoom, today]);

  // Keep the selected row visible (e.g. after Up / Down); do nothing when it already is.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const l = layoutRef.current;
    if (!el || !l || selectedId === null) return;
    const row = l.rows.find((r) => idKey(r.taskId) === idKey(selectedId));
    if (!row) return;
    const top = row.y; // body coordinates; the sticky header covers the first HEADER_HEIGHT px
    const visibleTop = el.scrollTop;
    const visibleBottom = el.scrollTop + el.clientHeight - HEADER_HEIGHT;
    if (top < visibleTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > visibleBottom) el.scrollTop = top + ROW_HEIGHT - (el.clientHeight - HEADER_HEIGHT);
  }, [selectedId]);

  const onScroll = useCallback(() => {
    if (scrollRef.current) lastScrollLeft.current = scrollRef.current.scrollLeft;
  }, []);
  const toggleValueColumn = useCallback(
    () => setValueColumn(useAppStore.getState().valueColumn === "duration" ? "hours" : "duration"),
    [setValueColumn],
  );
  const onSelectRow = useCallback(
    (id: string) => {
      select(id);
    },
    [select],
  );

  const onEdit = useCallback(
    (taskId: string, field: "name" | "duration" | "hours") => setEditing({ taskId, field }),
    [setEditing],
  );

  if (!layout) return null;
  return (
    <>
    <div className="chart-scroll" ref={scrollRef} onScroll={onScroll} style={scrollStyle}>
      <div
        className="chart-grid"
        style={{
          display: "grid",
          gridTemplateColumns: `${GRID_WIDTH}px ${layout.timelineWidth}px`,
          gridTemplateRows: `${HEADER_HEIGHT}px ${layout.bodyHeight}px`,
          width: GRID_WIDTH + layout.timelineWidth,
        }}
      >
        <GridHeader valueColumn={valueColumn} onToggleValueColumn={toggleValueColumn} />
        <TimelineHeader width={layout.timelineWidth} top={layout.headerTop} bottom={layout.headerBottom} />
        <div className="grid-body-wrap" style={{ position: "sticky", left: 0, zIndex: 1 }}>
          <GridBody
            rows={layout.rows}
            bodyHeight={layout.bodyHeight}
            selectedId={selectedId}
            onSelect={onSelectRow}
            onToggle={toggleCollapsed}
            onEdit={onEdit}
            valueColumn={valueColumn}
          />
          <InlineEditor rows={layout.rows} />
        </div>
        <TimelineBody
          layout={layout}
          selectedId={selectedId}
          selectedDependency={selectedDependency}
          onSelect={onSelectRow}
          onSelectDependency={selectDependency}
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          link={drag.overlay.link}
        />
      </div>
    </div>
    {drag.overlay.tooltip && (
      <div className="drag-tooltip" style={{ left: drag.overlay.tooltip.x + 12, top: drag.overlay.tooltip.y - 28 }}>
        {drag.overlay.tooltip.text}
      </div>
    )}
    </>
  );
}
