import {
  findViolations,
  formatDuration,
  getDerived,
  isWorkingDay,
  visibleRows,
  buildTreeIndex,
  type DerivedIndex,
  type TreeIndex,
  type Violation,
  type WorkCalendar,
} from "../../engine";
import { t } from "../../i18n";
import { addDays, dayOfWeek, diffDays } from "../../model/date";
import { idKey } from "../../model/id";
import type { GanttDocument, IsoDate, Zoom } from "../../model/types";
import {
  ARROW_GAP,
  BAR_OFFSET_Y,
  COLORS,
  DAY_WIDTH,
  ROW_HEIGHT,
  SUMMARY_OFFSET_Y,
} from "./constants";

export interface LayoutInput {
  doc: GanttDocument;
  derived: DerivedIndex;
  wc: WorkCalendar;
  zoom: Zoom;
  /** Collapsed task ids (any case). */
  collapsed: ReadonlySet<string>;
  valueColumn: "duration" | "hours";
  /** Fixed range (e.g. during a drag); computed from the tasks when omitted. */
  range?: { start: IsoDate; end: IsoDate };
  /** Optional precomputed values (avoid recomputation). */
  ix?: TreeIndex;
  violations?: readonly Violation[];
  /** Optional precomputed visible row ids (must match `collapsed`). */
  rowIds?: readonly string[];
}

export interface RowLayout {
  taskId: string;
  index: number;
  rowNo: number;
  y: number;
  depth: number;
  isParent: boolean;
  collapsed: boolean;
  name: string;
  valueText: string;
}
export interface BarLayout {
  taskId: string;
  /** Visible row index. */
  rowIndex: number;
  kind: "leaf" | "summary";
  x: number;
  w: number;
  /** Top of the bar rectangle (row top + offset). */
  y: number;
  color: string;
  progress: number;
  progressText: string;
  resourceText: string;
  labelX: number;
}
export interface ArrowLayout {
  /** Original (unreplaced) task ids of the dependency. */
  succId: string;
  predId: string;
  /** Visible row indexes the arrow is drawn between (after collapse replacement). */
  fromIndex: number;
  toIndex: number;
  d: string;
  head: string;
  violated: boolean;
}
export interface HeaderCell {
  x: number;
  w: number;
  label: string;
  /** Draw in the dimmed colour (non-working day). */
  muted?: boolean;
}
export interface NonWorkingBand {
  x: number;
  w: number;
}
export interface Layout {
  range: { start: IsoDate; end: IsoDate };
  zoom: Zoom;
  dayWidth: number;
  timelineWidth: number;
  bodyHeight: number;
  rows: RowLayout[];
  bars: BarLayout[];
  arrows: ArrowLayout[];
  headerTop: HeaderCell[];
  headerBottom: HeaderCell[];
  nonWorking: NonWorkingBand[];
  todayX: number | null;
}

// ---------------------------------------------------------------------------
// Date helpers (string based, calendar days)
// ---------------------------------------------------------------------------

function ymd(d: IsoDate): [number, number, number] {
  const [y, m, dd] = d.split("-");
  return [Number(y), Number(m), Number(dd)];
}
function monthStart(d: IsoDate): IsoDate {
  return `${d.slice(0, 7)}-01`;
}
function monthEnd(d: IsoDate): IsoDate {
  const [y, m] = ymd(d);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}
function mondayOnOrBefore(d: IsoDate): IsoDate {
  return addDays(d, -((dayOfWeek(d) + 6) % 7));
}
function sundayOnOrAfter(d: IsoDate): IsoDate {
  return addDays(d, (7 - dayOfWeek(d)) % 7);
}
function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** Displayed range (03 section 2.2). */
export function computeRange(
  derived: DerivedIndex,
  zoom: Zoom,
  today: IsoDate,
): { start: IsoDate; end: IsoDate } {
  let minStart: IsoDate | null = null;
  let maxEnd: IsoDate | null = null;
  for (const dt of derived.byId.values()) {
    if (minStart === null || dt.start < minStart) minStart = dt.start;
    if (maxEnd === null || dt.end > maxEnd) maxEnd = dt.end;
  }
  const s = minStart ?? today;
  const e = maxEnd ?? today;
  if (zoom === "month") {
    return { start: monthStart(addDays(s, -7)), end: monthEnd(addDays(e, 60)) };
  }
  return { start: mondayOnOrBefore(addDays(s, -7)), end: sundayOnOrAfter(addDays(e, 28)) };
}

/** Earliest start among all tasks (or today). Used for the initial scroll position. */
export function minTaskStart(derived: DerivedIndex, today: IsoDate): IsoDate {
  let m: IsoDate | null = null;
  for (const dt of derived.byId.values()) if (m === null || dt.start < m) m = dt.start;
  return m ?? today;
}

export function xOfDate(layout: Pick<Layout, "range" | "dayWidth">, d: IsoDate): number {
  return diffDays(layout.range.start, d) * layout.dayWidth;
}
export function dateAtX(layout: Pick<Layout, "range" | "dayWidth">, x: number): IsoDate {
  return addDays(layout.range.start, Math.floor(x / layout.dayWidth));
}
export function rowY(index: number): number {
  return index * ROW_HEIGHT;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function monthDayLabel(d: IsoDate): string {
  const [, m, dd] = ymd(d);
  return t("header.monthDay", { month: m, day: dd });
}

function buildHeader(
  range: { start: IsoDate; end: IsoDate },
  zoom: Zoom,
  dayWidth: number,
  wc: WorkCalendar,
): { top: HeaderCell[]; bottom: HeaderCell[] } {
  const top: HeaderCell[] = [];
  const bottom: HeaderCell[] = [];
  const totalDays = diffDays(range.start, range.end) + 1;
  const xOf = (d: IsoDate) => diffDays(range.start, d) * dayWidth;

  if (zoom === "day" || zoom === "week") {
    // Weeks Monday..Sunday (range is aligned to weeks).
    for (let off = 0; off < totalDays; off += 7) {
      const from = addDays(range.start, off);
      const to = addDays(from, 6);
      const x = off * dayWidth;
      const w = 7 * dayWidth;
      if (zoom === "day") {
        top.push({
          x,
          w,
          label: t("header.weekRange", { year: ymd(from)[0], from: monthDayLabel(from), to: monthDayLabel(to) }),
        });
      } else {
        const [, fm, fd] = ymd(from);
        const [, tm, td] = ymd(to);
        bottom.push({ x, w, label: t("header.weekCell", { fromMonth: fm, fromDay: fd, toMonth: tm, toDay: td }) });
      }
    }
    if (zoom === "day") {
      for (let i = 0; i < totalDays; i++) {
        const d = addDays(range.start, i);
        bottom.push({
          x: i * dayWidth,
          w: dayWidth,
          label: t("header.dayCell", { day: ymd(d)[2], weekday: t(`weekday.${dayOfWeek(d)}`) }),
          muted: wc.enabled && !isWorkingDay(d, wc),
        });
      }
    } else {
      // top: months, clipped to the range
      let cur = range.start;
      while (cur <= range.end) {
        const last = minDate(monthEnd(cur), range.end);
        const [y, m] = ymd(cur);
        top.push({ x: xOf(cur), w: (diffDays(cur, last) + 1) * dayWidth, label: t("header.month", { year: y, month: m }) });
        cur = addDays(last, 1);
      }
    }
  } else {
    let cur = range.start;
    while (cur <= range.end) {
      const lastM = minDate(monthEnd(cur), range.end);
      const [, m] = ymd(cur);
      bottom.push({ x: xOf(cur), w: (diffDays(cur, lastM) + 1) * dayWidth, label: t("header.monthShort", { month: m }) });
      cur = addDays(lastM, 1);
    }
    cur = range.start;
    while (cur <= range.end) {
      const [y] = ymd(cur);
      const lastY = minDate(`${y}-12-31`, range.end);
      top.push({ x: xOf(cur), w: (diffDays(cur, lastY) + 1) * dayWidth, label: t("header.year", { year: y }) });
      cur = addDays(lastY, 1);
    }
  }
  return { top, bottom };
}

function buildNonWorking(
  range: { start: IsoDate; end: IsoDate },
  zoom: Zoom,
  dayWidth: number,
  wc: WorkCalendar,
): NonWorkingBand[] {
  if (!wc.enabled || zoom === "month") return [];
  const bands: NonWorkingBand[] = [];
  const total = diffDays(range.start, range.end) + 1;
  let runStart = -1;
  for (let i = 0; i <= total; i++) {
    const off = i < total && !isWorkingDay(addDays(range.start, i), wc);
    if (off && runStart < 0) runStart = i;
    if (!off && runStart >= 0) {
      bands.push({ x: runStart * dayWidth, w: (i - runStart) * dayWidth });
      runStart = -1;
    }
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

export function arrowGeometry(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  succRowTop: number,
): { d: string; head: string } {
  const G = ARROW_GAP;
  let d: string;
  if (x2 - x1 >= 2 * G) {
    d = `M ${x1} ${y1} H ${x1 + G} V ${y2} H ${x2}`;
  } else {
    const yMid = y2 > y1 ? succRowTop : succRowTop + ROW_HEIGHT;
    d = `M ${x1} ${y1} H ${x1 + G} V ${yMid} H ${x2 - G} V ${y2} H ${x2}`;
  }
  const head = `${x2},${y2} ${x2 - 6},${y2 - 3.5} ${x2 - 6},${y2 + 3.5}`;
  return { d, head };
}

// ---------------------------------------------------------------------------
// computeLayout
// ---------------------------------------------------------------------------

function formatHours(h: number): string {
  return t("grid.hoursValue", { value: Number(h.toFixed(1)) });
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as Array<keyof typeof a>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * Replaces entries of `next` by the identical-looking entries of `prev` (same key, shallow equal),
 * and returns `prev` itself when nothing changed, so React.memo children can skip rendering.
 */
function reuse<T extends object>(next: T[], prev: readonly T[] | undefined, key: (x: T) => string): T[] {
  if (!prev) return next;
  const old = new Map<string, T>();
  for (const x of prev) old.set(key(x), x);
  const out = next.map((x) => {
    const o = old.get(key(x));
    return o !== undefined && shallowEqual(o, x) ? o : x;
  });
  const same = out.length === prev.length && out.every((x, i) => x === prev[i]);
  return same ? (prev as T[]) : out;
}

/**
 * Computes the whole chart geometry. When `prev` is given, unchanged rows / bars / arrows / header
 * cells keep their previous object identity (and the previous Layout is returned when nothing
 * changed), which keeps memoised SVG children from re-rendering while dragging.
 */
export function computeLayout(input: LayoutInput, today: IsoDate, prev?: Layout | null): Layout {
  const next = buildLayout(input, today);
  if (!prev) return next;
  const stable: Layout = {
    ...next,
    rows: reuse(next.rows, prev.rows, (r) => r.taskId),
    bars: reuse(next.bars, prev.bars, (b) => b.taskId),
    arrows: reuse(next.arrows, prev.arrows, (a) => `${a.succId}|${a.predId}`),
    headerTop: reuse(next.headerTop, prev.headerTop, (c) => String(c.x)),
    headerBottom: reuse(next.headerBottom, prev.headerBottom, (c) => String(c.x)),
    nonWorking: reuse(next.nonWorking, prev.nonWorking, (b) => String(b.x)),
  };
  const { range: r1, ...rest1 } = stable;
  const { range: r0, ...rest0 } = prev;
  return shallowEqual(r1, r0) && shallowEqual(rest1, rest0) ? prev : stable;
}

function buildLayout(input: LayoutInput, today: IsoDate): Layout {
  const { doc, derived, wc, zoom, valueColumn } = input;
  const ix = input.ix ?? buildTreeIndex(doc);
  const dayWidth = DAY_WIDTH[zoom];
  const range = input.range ?? computeRange(derived, zoom, today);
  const base = { range, dayWidth };

  const collapsedKeys = new Set<string>();
  for (const c of input.collapsed) collapsedKeys.add(idKey(c));

  const colorOf = new Map<string, string>();
  for (const c of doc.colorLabels ?? []) colorOf.set(idKey(c.id), c.color);
  const resName = new Map<string, string>();
  for (const r of doc.resources ?? []) resName.set(idKey(r.id), r.name);

  const ids = input.rowIds ?? visibleRows(ix, collapsedKeys);
  // `#` is the stable serial number among all tasks (doc order), independent of collapsing.
  const serialOf = new Map<string, number>();
  derived.order.forEach((id, i) => serialOf.set(idKey(id), i + 1));
  const rowIndexOf = new Map<string, number>();
  const rows: RowLayout[] = [];
  const bars: BarLayout[] = [];

  ids.forEach((id, index) => {
    const dt = getDerived(derived, id)!;
    const task = ix.byId.get(idKey(id))!;
    rowIndexOf.set(idKey(id), index);
    const y = rowY(index);
    let valueText: string;
    if (valueColumn === "duration") valueText = formatDuration(dt.durationDays, wc);
    else valueText = dt.hours !== undefined ? formatHours(dt.hours) : "";
    rows.push({
      taskId: id,
      index,
      rowNo: serialOf.get(idKey(id)) ?? index + 1,
      y,
      depth: dt.depth,
      isParent: dt.isParent,
      collapsed: collapsedKeys.has(idKey(id)),
      name: task.name,
      valueText,
    });

    const x = xOfDate(base, dt.start);
    const rawW = xOfDate(base, dt.end) + dayWidth - x;
    const color = (task.colorLabelId ? colorOf.get(idKey(task.colorLabelId)) : undefined) ?? undefined;
    const resourceText = (task.resourceIds ?? [])
      .map((rid) => resName.get(idKey(rid)))
      .filter((n): n is string => n !== undefined)
      .join(", ");
    const kind = dt.isParent ? "summary" : "leaf";
    const w = kind === "leaf" ? Math.max(2, rawW) : rawW;
    bars.push({
      taskId: id,
      rowIndex: index,
      kind,
      x,
      w,
      y: y + (kind === "leaf" ? BAR_OFFSET_Y : SUMMARY_OFFSET_Y),
      color: color ?? (kind === "leaf" ? COLORS.barDefault : COLORS.summaryDefault),
      progress: dt.progress,
      progressText: `${Math.round(dt.progress)}%`,
      resourceText,
      labelX: x + w + 6,
    });
  });

  // Arrows
  const violated = new Set<string>();
  for (const v of input.violations ?? findViolations(doc, wc)) violated.add(`${idKey(v.succId)}|${idKey(v.predId)}`);
  const visibleRowOf = (id: string): number | undefined => {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(idKey(cur))) {
      seen.add(idKey(cur));
      const r = rowIndexOf.get(idKey(cur));
      if (r !== undefined) return r;
      cur = ix.parentOf.get(idKey(cur)) ?? null;
    }
    return undefined;
  };
  const arrows: ArrowLayout[] = [];
  for (const task of doc.tasks) {
    for (const dep of task.dependencies ?? []) {
      const si = visibleRowOf(task.id);
      const pi = visibleRowOf(dep.predecessorId);
      if (si === undefined || pi === undefined || si === pi) continue;
      const pb = bars[pi]!;
      const sb = bars[si]!;
      const x1 = pb.x + pb.w;
      const x2 = sb.x;
      const y1 = rowY(pi) + ROW_HEIGHT / 2;
      const y2 = rowY(si) + ROW_HEIGHT / 2;
      const { d, head } = arrowGeometry(x1, y1, x2, y2, rowY(si));
      arrows.push({
        succId: task.id,
        predId: dep.predecessorId,
        fromIndex: pi,
        toIndex: si,
        d,
        head,
        violated: violated.has(`${idKey(task.id)}|${idKey(dep.predecessorId)}`),
      });
    }
  }

  const { top, bottom } = buildHeader(range, zoom, dayWidth, wc);
  const inRange = today >= range.start && today <= range.end;

  return {
    range,
    zoom,
    dayWidth,
    timelineWidth: (diffDays(range.start, range.end) + 1) * dayWidth,
    bodyHeight: rows.length * ROW_HEIGHT,
    rows,
    bars,
    arrows,
    headerTop: top,
    headerBottom: bottom,
    nonWorking: buildNonWorking(range, zoom, dayWidth, wc),
    todayX: inRange ? xOfDate(base, today) : null,
  };
}
