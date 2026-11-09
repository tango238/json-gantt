import { idKey } from "../../model/id";
import { memo, useCallback } from "react";
import { COL_NAME, COL_NO, COLORS, FONT_FAMILY, GRID_WIDTH, INDENT_PX, ROW_HEIGHT, TOGGLE_PX } from "./constants";
import type { RowLayout } from "./layout";

interface RowProps {
  row: RowLayout;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  /** Interactive use only (omitted by the PDF export). */
  onEdit?: (id: string, field: "name" | "duration" | "hours") => void;
  valueColumn?: "duration" | "hours";
}

/** Which grid column a mouse event landed in. */
function columnAt(e: { clientX: number; currentTarget: Element }): "no" | "name" | "value" {
  const svg = (e.currentTarget as SVGElement).ownerSVGElement;
  const x = e.clientX - (svg?.getBoundingClientRect().left ?? 0);
  if (x < COL_NO) return "no";
  return x < COL_NO + COL_NAME ? "name" : "value";
}

const GridRow = memo(function GridRow({ row, selected, onSelect, onToggle, onEdit, valueColumn }: RowProps) {
  const nameX = COL_NO + 4 + row.depth * INDENT_PX;
  const mid = ROW_HEIGHT / 2;
  const tx = nameX + TOGGLE_PX / 2;
  const base = { fontFamily: FONT_FAMILY, fontSize: 12, fill: COLORS.text, dominantBaseline: "central" as const };
  return (
    <g
      transform={`translate(0 ${row.y})`}
      data-row-id={row.taskId}
      onClick={(e) => {
        // Re-click on the name of an already selected row starts editing (03 section 7).
        if (selected && columnAt(e) === "name") onEdit?.(row.taskId, "name");
        onSelect(row.taskId);
      }}
      onDoubleClick={(e) => {
        const col = columnAt(e);
        if (col === "name") onEdit?.(row.taskId, "name");
        else if (col === "value" && !row.isParent) onEdit?.(row.taskId, valueColumn ?? "duration");
      }}
      style={{ cursor: "default" }}
    >
      <rect
        className="row-bg"
        x={0}
        y={0}
        width={GRID_WIDTH}
        height={ROW_HEIGHT}
        fill={selected ? COLORS.selectedRow : "transparent"}
      />
      <line x1={0} x2={GRID_WIDTH} y1={ROW_HEIGHT - 0.5} y2={ROW_HEIGHT - 0.5} stroke={COLORS.border} />
      <text x={COL_NO - 6} y={mid} textAnchor="end" {...base} fill={COLORS.textMuted}>
        {row.rowNo}
      </text>
      {row.isParent && (
        <g
          className="toggle"
          data-testid="toggle-collapse"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.taskId);
          }}
          style={{ cursor: "pointer" }}
        >
          <rect x={nameX} y={0} width={TOGGLE_PX} height={ROW_HEIGHT} fill="transparent" />
          <polygon
            fill={COLORS.textMuted}
            points={
              row.collapsed
                ? `${tx - 2.5},${mid - 4} ${tx + 3.5},${mid} ${tx - 2.5},${mid + 4}`
                : `${tx - 4},${mid - 2.5} ${tx + 4},${mid - 2.5} ${tx},${mid + 3.5}`
            }
          />
        </g>
      )}
      <svg x={COL_NO} y={0} width={COL_NAME} height={ROW_HEIGHT} overflow="hidden">
        <text x={nameX - COL_NO + TOGGLE_PX + 2} y={mid} {...base} fontWeight={row.isParent ? 700 : 400}>
          {row.name}
        </text>
      </svg>
      <text x={GRID_WIDTH - 6} y={mid} textAnchor="end" {...base}>
        {row.valueText}
      </text>
    </g>
  );
});

interface Props {
  rows: readonly RowLayout[];
  bodyHeight: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  /** Interactive use only (omitted by the PDF export). */
  onEdit?: (id: string, field: "name" | "duration" | "hours") => void;
  valueColumn?: "duration" | "hours";
}

function GridBodyImpl({ rows, bodyHeight, selectedId, onSelect, onToggle, onEdit, valueColumn }: Props) {
  const sel = selectedId !== null ? idKey(selectedId) : null;
  const select = useCallback((id: string) => onSelect(id), [onSelect]);
  return (
    <svg
      className="grid-body"
      width={GRID_WIDTH}
      height={bodyHeight}
      style={{ position: "sticky", left: 0, zIndex: 1, display: "block", background: "#fff" }}
    >
      {rows.map((r) => (
        <GridRow
          key={r.taskId}
          row={r}
          selected={sel !== null && idKey(r.taskId) === sel}
          onSelect={select}
          onToggle={onToggle}
          onEdit={onEdit}
          valueColumn={valueColumn}
        />
      ))}
      <line x1={GRID_WIDTH - 0.5} x2={GRID_WIDTH - 0.5} y1={0} y2={bodyHeight} stroke={COLORS.border} />
    </svg>
  );
}

export const GridBody = memo(GridBodyImpl);
