import { idKey } from "../../model/id";
import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { Arrows } from "./Arrows";
import { Bars } from "./Bars";
import { COLORS, ROW_HEIGHT } from "./constants";
import type { Layout } from "./layout";
import type { LinkOverlay } from "./useDrag";

interface Props {
  layout: Layout;
  selectedId: string | null;
  selectedDependency: { succId: string; predId: string } | null;
  onSelect: (id: string) => void;
  onSelectDependency: (dep: { succId: string; predId: string }) => void;
  onPointerDown?: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<SVGSVGElement>) => void;
  /** Dashed link line being dragged (03 section 6.2). */
  link?: LinkOverlay | null;
}

function TimelineBodyImpl({
  layout,
  selectedId,
  selectedDependency,
  onSelect,
  onSelectDependency,
  onPointerDown,
  onPointerMove,
  link,
}: Props) {
  const { timelineWidth: width, bodyHeight: height, rows, nonWorking, dayWidth, zoom, range } = layout;
  const sel = selectedId !== null ? idKey(selectedId) : null;
  const dayLines: number[] = [];
  if (zoom === "day") {
    const days = Math.round(width / dayWidth);
    for (let i = 1; i < days; i++) dayLines.push(i * dayWidth);
  }
  return (
    <svg className="timeline-body" width={width} height={height} data-range-start={range.start}
      style={{ display: "block" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      {nonWorking.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={height} fill={COLORS.nonWorking} />
      ))}
      {dayLines.map((x) => (
        <line key={x} x1={x + 0.5} x2={x + 0.5} y1={0} y2={height} stroke={COLORS.dayLine} />
      ))}
      {rows.map((r) => (
        <g key={r.taskId} data-row-id={r.taskId} onClick={() => onSelect(r.taskId)}>
          <rect
            className="row-bg"
            x={0}
            y={r.y}
            width={width}
            height={ROW_HEIGHT}
            fill={sel !== null && idKey(r.taskId) === sel ? COLORS.selectedRow : "transparent"}
            fillOpacity={0.6}
          />
          <line x1={0} x2={width} y1={r.y + ROW_HEIGHT - 0.5} y2={r.y + ROW_HEIGHT - 0.5} stroke={COLORS.border} />
        </g>
      ))}
      <Arrows
        arrows={layout.arrows}
        selectedId={selectedId}
        selectedDependency={selectedDependency}
        onSelectDependency={onSelectDependency}
      />
      <Bars bars={layout.bars} selectedId={selectedId} onSelect={onSelect} linkHandles={onPointerDown !== undefined} />
      {link && (
        <g pointerEvents="none" className="link-overlay">
          {link.targetId !== null &&
            layout.bars
              .filter((b) => b.taskId === link.targetId)
              .map((b) => (
                <rect
                  key={b.taskId}
                  x={b.x - 2}
                  y={b.rowIndex * ROW_HEIGHT + 2}
                  width={b.w + 4}
                  height={ROW_HEIGHT - 4}
                  rx={3}
                  fill="none"
                  stroke={link.valid ? COLORS.selection : COLORS.arrowViolated}
                  strokeWidth={2}
                />
              ))}
          <line
            x1={link.fromX}
            y1={link.fromY}
            x2={link.toX}
            y2={link.toY}
            stroke={link.targetId !== null && !link.valid ? COLORS.arrowViolated : COLORS.selection}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        </g>
      )}
      {layout.todayX !== null && (
        <line
          className="today-line"
          x1={layout.todayX}
          x2={layout.todayX}
          y1={0}
          y2={height}
          stroke={COLORS.today}
          strokeWidth={2}
          pointerEvents="none"
        />
      )}
    </svg>
  );
}

export const TimelineBody = memo(TimelineBodyImpl);
