import { memo } from "react";
import { COLORS, FONT_FAMILY, HEADER_HEIGHT, HEADER_ROW_HEIGHT } from "./constants";
import type { HeaderCell } from "./layout";

function Row({ cells, y, prefix }: { cells: readonly HeaderCell[]; y: number; prefix: string }) {
  return (
    <g>
      {cells.map((c, i) => {
        const id = `${prefix}-${i}`;
        return (
          <g key={i}>
            <clipPath id={id}>
              <rect x={c.x} y={y} width={c.w} height={HEADER_ROW_HEIGHT} />
            </clipPath>
            <line x1={c.x + 0.5} x2={c.x + 0.5} y1={y} y2={y + HEADER_ROW_HEIGHT} stroke={COLORS.border} />
            <text
              x={c.x + c.w / 2}
              y={y + HEADER_ROW_HEIGHT / 2}
              textAnchor="middle"
              clipPath={`url(#${id})`}
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: 11,
                fill: c.muted ? COLORS.textDim : COLORS.text,
                dominantBaseline: "central",
              }}
            >
              {c.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

interface Props {
  width: number;
  top: readonly HeaderCell[];
  bottom: readonly HeaderCell[];
}

function TimelineHeaderImpl({ width, top, bottom }: Props) {
  return (
    <svg
      className="timeline-header"
      width={width}
      height={HEADER_HEIGHT}
      style={{ position: "sticky", top: 0, zIndex: 2, display: "block" }}
    >
      <rect x={0} y={0} width={width} height={HEADER_HEIGHT} fill={COLORS.headerBg} />
      <Row cells={top} y={0} prefix="th-top" />
      <Row cells={bottom} y={HEADER_ROW_HEIGHT} prefix="th-bot" />
      <line x1={0} x2={width} y1={HEADER_ROW_HEIGHT - 0.5} y2={HEADER_ROW_HEIGHT - 0.5} stroke={COLORS.border} />
      <line x1={0} x2={width} y1={HEADER_HEIGHT - 0.5} y2={HEADER_HEIGHT - 0.5} stroke={COLORS.border} />
    </svg>
  );
}

export const TimelineHeader = memo(TimelineHeaderImpl);
