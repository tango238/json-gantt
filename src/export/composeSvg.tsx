import { renderToStaticMarkup } from "react-dom/server";
import {
  buildTreeIndex,
  compileCalendar,
  deriveAll,
  findViolations,
  type DerivedIndex,
  type WorkCalendar,
} from "../engine";
import { t } from "../i18n";
import { addDays, dayOfWeek } from "../model/date";
import type { GanttDocument, IsoDate, Zoom } from "../model/types";
import {
  COLORS,
  EXPORT_TITLE_HEIGHT,
  FONT_FAMILY,
  GRID_WIDTH,
  HEADER_HEIGHT,
} from "../components/chart/constants";
import { GridBody } from "../components/chart/GridBody";
import { GridHeader } from "../components/chart/GridHeader";
import { computeLayout } from "../components/chart/layout";
import { TimelineBody } from "../components/chart/TimelineBody";
import { TimelineHeader } from "../components/chart/TimelineHeader";

export const EXPORT_FONT_FAMILY = "Noto Sans JP";

export interface ComposeInput {
  /** Document to export (the displayed one). Zoom and collapsed ids come from `doc.view`. */
  doc: GanttDocument;
  valueColumn: "duration" | "hours";
  /** Print date, ISO. Only used for the title band and for an empty document's range. */
  today: IsoDate;
  derived?: DerivedIndex;
  wc?: WorkCalendar;
}

export interface ComposedSvg {
  svg: string;
  width: number;
  height: number;
}

const noop = () => {};
const slash = (d: IsoDate) => d.replace(/-/g, "/");

/**
 * Post-process the markup of the on-screen components into something usvg handles:
 * - the screen font stack becomes the bundled font
 * - transparent hit areas are dropped / made `none`
 * - tooltips (`<title>`) are removed
 */
function cleanMarkup(markup: string): string {
  const screenFont = renderToStaticMarkup(<i style={{ fontFamily: FONT_FAMILY }} />).match(/font-family:([^"]*)"/)![1]!;
  return markup
    .split(screenFont)
    .join(`'${EXPORT_FONT_FAMILY}'`)
    .replace(/<path[^>]*stroke="transparent"[^>]*\/>/g, "")
    .replace(/<title>[^<]*<\/title>/g, "")
    .replace(/(fill|stroke)="transparent"/g, '$1="none"');
}

/** Tight export range: all tasks, aligned to the zoom unit (empty document: the week of `today`). */
export function exportRange(
  derived: DerivedIndex,
  zoom: Zoom,
  today: IsoDate,
): { start: IsoDate; end: IsoDate } {
  let s: IsoDate | null = null;
  let e: IsoDate | null = null;
  for (const dt of derived.byId.values()) {
    if (s === null || dt.start < s) s = dt.start;
    if (e === null || dt.end > e) e = dt.end;
  }
  const empty = s === null || e === null;
  const a = s ?? today;
  const b = e ?? today;
  if (zoom === "month") {
    const next = addDays(`${b.slice(0, 7)}-01`, 32);
    return { start: `${a.slice(0, 7)}-01`, end: addDays(`${next.slice(0, 7)}-01`, -1) };
  }
  if (zoom === "week" || empty) {
    return { start: addDays(a, -((dayOfWeek(a) + 6) % 7)), end: addDays(b, (7 - dayOfWeek(b)) % 7) };
  }
  return { start: addDays(a, -1), end: addDays(b, 1) };
}

export function composeSvg(input: ComposeInput): ComposedSvg {
  const { doc, valueColumn, today } = input;
  const wc = input.wc ?? compileCalendar(doc.project.calendar);
  const derived = input.derived ?? deriveAll(doc, wc);
  const zoom = doc.view?.zoom ?? "day";
  const layout = {
    ...computeLayout(
      {
        doc,
        derived,
        wc,
        zoom,
        collapsed: new Set(doc.view?.collapsedTaskIds ?? []),
        valueColumn,
        range: exportRange(derived, zoom, today),
        ix: buildTreeIndex(doc),
        violations: findViolations(doc, wc),
      },
      today,
    ),
    todayX: null,
  };

  const W = GRID_WIDTH + layout.timelineWidth;
  const H = EXPORT_TITLE_HEIGHT + HEADER_HEIGHT + layout.bodyHeight;

  let minStart: IsoDate | null = null;
  let maxEnd: IsoDate | null = null;
  for (const dt of derived.byId.values()) {
    if (minStart === null || dt.start < minStart) minStart = dt.start;
    if (maxEnd === null || dt.end > maxEnd) maxEnd = dt.end;
  }
  const period = t("export.period", { from: slash(minStart ?? today), to: slash(maxEnd ?? today) });
  const printed = t("export.printedOn", { date: slash(today) });

  const markup = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      fontFamily={EXPORT_FONT_FAMILY}
    >
      <rect width={W} height={H} fill="#FFFFFF" />
      <svg x={0} y={0} width={GRID_WIDTH} height={EXPORT_TITLE_HEIGHT}>
        <text x={8} y={17} fontSize={14} fontWeight={700} fill={COLORS.text}>
          {doc.project.name}
        </text>
        <text x={8} y={32} fontSize={10} fontWeight={400} fill={COLORS.textMuted}>
          {`${period} ・ ${printed}`}
        </text>
      </svg>
      <g transform={`translate(0,${EXPORT_TITLE_HEIGHT})`}>
        <GridHeader valueColumn={valueColumn} onToggleValueColumn={noop} />
      </g>
      <g transform={`translate(${GRID_WIDTH},${EXPORT_TITLE_HEIGHT})`}>
        <TimelineHeader width={layout.timelineWidth} top={layout.headerTop} bottom={layout.headerBottom} />
      </g>
      <g transform={`translate(0,${EXPORT_TITLE_HEIGHT + HEADER_HEIGHT})`}>
        <GridBody rows={layout.rows} bodyHeight={layout.bodyHeight} selectedId={null} onSelect={noop} onToggle={noop} />
      </g>
      <g transform={`translate(${GRID_WIDTH},${EXPORT_TITLE_HEIGHT + HEADER_HEIGHT})`}>
        <TimelineBody
          layout={layout}
          selectedId={null}
          selectedDependency={null}
          onSelect={noop}
          onSelectDependency={noop}
        />
      </g>
    </svg>,
  );
  return { svg: cleanMarkup(markup), width: W, height: H };
}
