import type { IsoDate } from "./types";

// All calculations use integer arithmetic (proleptic Gregorian calendar);
// the local timezone of Date is never consulted except in todayIso().

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

export function isValidIsoDate(s: string): boolean {
  if (typeof s !== "string") return false;
  const m = RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

// Days from civil (Howard Hinnant's algorithm).
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

/** 1970-01-01 = 0. Input must be a valid IsoDate. */
export function toEpochDay(d: IsoDate): number {
  const m = RE.exec(d);
  if (!m) throw new RangeError(`Invalid ISO date: ${d}`);
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function fromEpochDay(n: number): IsoDate {
  const [y, m, d] = civilFromDays(n);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(d) + n);
}

/** b - a in days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(d: IsoDate): number {
  // 1970-01-01 was a Thursday (4).
  return (((toEpochDay(d) + 4) % 7) + 7) % 7;
}

/** Today's local date. Call from the UI layer only; pass the value into the engine. */
export function todayIso(): IsoDate {
  const n = new Date();
  return `${String(n.getFullYear()).padStart(4, "0")}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
