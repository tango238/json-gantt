import { idKey } from "../../model/id";
import { memo } from "react";
import { COLORS, FONT_FAMILY, BAR_HEIGHT, ROW_HEIGHT, SUMMARY_HEIGHT } from "./constants";
import type { BarLayout } from "./layout";

interface BarProps {
  bar: BarLayout;
  linkHandle: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** Dependency-link handle, shown while the bar is hovered (03 section 6.1). */
function LinkHandle({ bar }: { bar: BarLayout }) {
  const cx = bar.x + bar.w + 8;
  const cy = bar.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  return (
    <g className="link-handle" data-link-handle="">
      <rect x={bar.x + bar.w} y={cy - 6} width={14} height={12} fill="transparent" />
      <circle cx={cx} cy={cy} r={4} fill="#fff" stroke={COLORS.selection} strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={6} fill="transparent" />
    </g>
  );
}

const labelStyle = { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLORS.label, dominantBaseline: "central" as const };

const LeafBar = memo(function LeafBar({ bar, linkHandle, selected, onSelect }: BarProps) {
  const clipId = `bar-clip-${bar.taskId}`;
  const cy = bar.y + BAR_HEIGHT / 2;
  const pw = (bar.w * bar.progress) / 100;
  return (
    <g data-task-id={bar.taskId} data-kind="leaf" className="bar-group" onClick={() => onSelect(bar.taskId)}>
      <clipPath id={clipId}>
        <rect x={bar.x} y={bar.y} width={bar.w} height={BAR_HEIGHT} rx={3} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x={bar.x} y={bar.y} width={bar.w} height={BAR_HEIGHT} fill={bar.color} fillOpacity={0.35} />
        {pw > 0 && <rect x={bar.x} y={bar.y} width={pw} height={BAR_HEIGHT} fill={bar.color} />}
      </g>
      {selected && (
        <rect
          x={bar.x}
          y={bar.y}
          width={bar.w}
          height={BAR_HEIGHT}
          rx={3}
          fill="none"
          stroke={COLORS.selection}
          strokeWidth={2}
        />
      )}
      {bar.w >= 36 && (
        <text
          x={bar.x + bar.w / 2}
          y={cy}
          textAnchor="middle"
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 10,
            fill: bar.progress >= 50 ? COLORS.onDark : COLORS.text,
            dominantBaseline: "central",
            pointerEvents: "none",
          }}
        >
          {bar.progressText}
        </text>
      )}
      {bar.resourceText && (
        <text x={bar.labelX} y={cy} style={{ ...labelStyle, pointerEvents: "none" }}>
          {bar.resourceText}
        </text>
      )}
      {linkHandle && <LinkHandle bar={bar} />}
    </g>
  );
});

const SummaryBar = memo(function SummaryBar({ bar, linkHandle, selected, onSelect }: BarProps) {
  const { x, w, y: y0 } = bar;
  const pw = (w * bar.progress) / 100;
  return (
    <g data-task-id={bar.taskId} data-kind="summary" className="bar-group" onClick={() => onSelect(bar.taskId)}>
      <rect x={x} y={y0} width={w} height={SUMMARY_HEIGHT} fill={bar.color} fillOpacity={0.45} />
      {pw > 0 && <rect x={x} y={y0} width={pw} height={SUMMARY_HEIGHT} fill={bar.color} />}
      <polygon
        fill={bar.color}
        points={`${x},${y0 + SUMMARY_HEIGHT} ${x + 7},${y0 + SUMMARY_HEIGHT} ${x},${y0 + SUMMARY_HEIGHT + 6}`}
      />
      <polygon
        fill={bar.color}
        points={`${x + w},${y0 + SUMMARY_HEIGHT} ${x + w - 7},${y0 + SUMMARY_HEIGHT} ${x + w},${y0 + SUMMARY_HEIGHT + 6}`}
      />
      {selected && (
        <rect
          x={x - 1}
          y={y0 - 1}
          width={w + 2}
          height={SUMMARY_HEIGHT + 2}
          fill="none"
          stroke={COLORS.selection}
          strokeWidth={2}
        />
      )}
      <text x={bar.labelX} y={y0 + 6} style={{ ...labelStyle, pointerEvents: "none" }}>
        {bar.progressText}
        {bar.resourceText && <tspan dx={8}>{bar.resourceText}</tspan>}
      </text>
      {linkHandle && <LinkHandle bar={bar} />}
    </g>
  );
});

interface Props {
  bars: readonly BarLayout[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Show the hover link handle (interactive chart only, never in the PDF export). */
  linkHandles?: boolean;
}

function BarsImpl({ bars, selectedId, onSelect, linkHandles = false }: Props) {
  const sel = selectedId !== null ? idKey(selectedId) : null;
  return (
    <g className="bars">
      {bars.map((b) => {
        const selected = sel !== null && idKey(b.taskId) === sel;
        return b.kind === "leaf" ? (
          <LeafBar key={b.taskId} bar={b} linkHandle={linkHandles} selected={selected} onSelect={onSelect} />
        ) : (
          <SummaryBar key={b.taskId} bar={b} linkHandle={linkHandles} selected={selected} onSelect={onSelect} />
        );
      })}
    </g>
  );
}

export const Bars = memo(BarsImpl);
