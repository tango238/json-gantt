import { memo } from "react";
import { t } from "../../i18n";
import { COL_NAME, COL_NO, COL_VALUE, COLORS, FONT_FAMILY, GRID_WIDTH, HEADER_HEIGHT } from "./constants";

interface Props {
  valueColumn: "duration" | "hours";
  onToggleValueColumn: () => void;
}

function GridHeaderImpl({ valueColumn, onToggleValueColumn }: Props) {
  const mid = HEADER_HEIGHT / 2;
  const text = { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLORS.textMuted, dominantBaseline: "central" as const };
  return (
    <svg
      className="grid-header"
      width={GRID_WIDTH}
      height={HEADER_HEIGHT}
      style={{ position: "sticky", top: 0, left: 0, zIndex: 3, display: "block" }}
    >
      <rect x={0} y={0} width={GRID_WIDTH} height={HEADER_HEIGHT} fill={COLORS.headerBg} />
      <line x1={0} x2={GRID_WIDTH} y1={HEADER_HEIGHT - 0.5} y2={HEADER_HEIGHT - 0.5} stroke={COLORS.border} />
      <line x1={COL_NO + 0.5} x2={COL_NO + 0.5} y1={0} y2={HEADER_HEIGHT} stroke={COLORS.border} />
      <line x1={COL_NO + COL_NAME + 0.5} x2={COL_NO + COL_NAME + 0.5} y1={0} y2={HEADER_HEIGHT} stroke={COLORS.border} />
      <text x={COL_NO - 6} y={mid} textAnchor="end" {...text}>
        {t("grid.no")}
      </text>
      <text x={COL_NO + 6} y={mid} {...text}>
        {t("grid.name")}
      </text>
      <g
        className="value-header"
        style={{ cursor: "pointer" }}
        onClick={onToggleValueColumn}
        data-testid="toggle-value-column"
      >
        <title>{t("toolbar.toggleValueColumn")}</title>
        <rect x={COL_NO + COL_NAME + 1} y={0} width={COL_VALUE - 1} height={HEADER_HEIGHT} fill="transparent" />
        <text x={GRID_WIDTH - 6} y={mid} textAnchor="end" {...text}>
          {t(valueColumn === "duration" ? "grid.duration" : "grid.hours")}
        </text>
      </g>
    </svg>
  );
}

export const GridHeader = memo(GridHeaderImpl);
