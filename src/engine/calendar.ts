import { addDays, dayOfWeek, diffDays } from "../model/date";
import type { Calendar, IsoDate } from "../model/types";
import { CalendarError } from "./errors";

export interface WorkCalendar {
  readonly enabled: boolean;
  readonly weekends: ReadonlySet<number>;
  readonly holidays: ReadonlySet<IsoDate>;
  /** Working days that make up "1w" in duration text. */
  readonly daysPerWeek: number;
}

/** Upper bound of days a single scanning call may advance (about 10 years). */
const MAX_SCAN_DAYS = 3660;

export function compileCalendar(cal: Calendar | undefined | null): WorkCalendar {
  if (!cal) {
    return { enabled: false, weekends: new Set(), holidays: new Set(), daysPerWeek: 7 };
  }
  const weekends = new Set<number>(cal.weekends);
  return {
    enabled: true,
    weekends,
    holidays: new Set<IsoDate>(cal.holidays),
    daysPerWeek: 7 - weekends.size,
  };
}

export function isWorkingDay(d: IsoDate, wc: WorkCalendar): boolean {
  if (!wc.enabled) return true;
  return !wc.weekends.has(dayOfWeek(d)) && !wc.holidays.has(d);
}

export function nextWorkingDay(d: IsoDate, wc: WorkCalendar): IsoDate {
  let cur = d;
  for (let i = 0; !isWorkingDay(cur, wc); i++) {
    if (i >= MAX_SCAN_DAYS) throw new CalendarError();
    cur = addDays(cur, 1);
  }
  return cur;
}

export function prevWorkingDay(d: IsoDate, wc: WorkCalendar): IsoDate {
  let cur = d;
  for (let i = 0; !isWorkingDay(cur, wc); i++) {
    if (i >= MAX_SCAN_DAYS) throw new CalendarError();
    cur = addDays(cur, -1);
  }
  return cur;
}

/** n > 0: n-th working day after d; n < 0: |n|-th working day before d; n = 0: d itself. */
export function addWorkingDays(d: IsoDate, n: number, wc: WorkCalendar): IsoDate {
  if (n === 0) return d;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let cur = d;
  let scanned = 0;
  while (remaining > 0) {
    if (++scanned > MAX_SCAN_DAYS + Math.abs(n)) throw new CalendarError();
    cur = addDays(cur, step);
    if (isWorkingDay(cur, wc)) remaining--;
  }
  return cur;
}

/** Number of working days in [a, b] (both inclusive). 0 when b < a. */
export function workingDaysBetween(a: IsoDate, b: IsoDate, wc: WorkCalendar): number {
  const span = diffDays(a, b);
  if (span < 0) return 0;
  if (!wc.enabled) return span + 1;
  let count = 0;
  let cur = a;
  for (let i = 0; i <= span; i++) {
    if (isWorkingDay(cur, wc)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

/** b > a: working days in (a, b]; b < a: -(working days in [b, a)); equal: 0. */
export function workingDayOffset(a: IsoDate, b: IsoDate, wc: WorkCalendar): number {
  const diff = diffDays(a, b);
  if (diff === 0) return 0;
  if (diff > 0) return workingDaysBetween(addDays(a, 1), b, wc);
  return -workingDaysBetween(b, addDays(a, -1), wc);
}

export function durationOf(start: IsoDate, end: IsoDate, wc: WorkCalendar): number {
  return workingDaysBetween(start, end, wc);
}

export function formatDuration(days: number, wc: WorkCalendar): string {
  if (days <= 0) return "0d";
  const w = Math.floor(days / wc.daysPerWeek);
  const r = days % wc.daysPerWeek;
  if (w === 0) return `${r}d`;
  if (r === 0) return `${w}w`;
  return `${w}w${r}d`;
}

const DURATION_RE = /^(?:(\d+)\s*w)?\s*(?:(\d+)\s*d?)?$/;

export function parseDuration(text: string, wc: WorkCalendar): number | null {
  const m = DURATION_RE.exec(text.trim().toLowerCase());
  if (!m) return null;
  if (m[1] === undefined && m[2] === undefined) return null;
  const total = Number(m[1] ?? 0) * wc.daysPerWeek + Number(m[2] ?? 0);
  return total > 0 ? total : null;
}
