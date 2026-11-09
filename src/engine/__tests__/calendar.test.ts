import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  compileCalendar,
  durationOf,
  formatDuration,
  isWorkingDay,
  nextWorkingDay,
  parseDuration,
  prevWorkingDay,
  workingDayOffset,
  workingDaysBetween,
} from "../calendar";
import { CalendarError } from "../errors";
import { WC0, WC5 } from "./fixtures";

describe("calendar", () => {
  it("C1: isWorkingDay", () => {
    expect(isWorkingDay("2023-05-27", WC5)).toBe(false);
    expect(isWorkingDay("2023-05-26", WC5)).toBe(true);
    expect(isWorkingDay("2023-05-27", WC0)).toBe(true);
  });

  it("C2: nextWorkingDay", () => {
    expect(nextWorkingDay("2023-05-27", WC5)).toBe("2023-05-29");
    expect(nextWorkingDay("2023-05-26", WC5)).toBe("2023-05-26");
  });

  it("C3: prevWorkingDay", () => {
    expect(prevWorkingDay("2023-05-28", WC5)).toBe("2023-05-26");
    expect(prevWorkingDay("2023-05-26", WC5)).toBe("2023-05-26");
  });

  it("C4: addWorkingDays", () => {
    expect(addWorkingDays("2023-05-25", 2, WC5)).toBe("2023-05-29");
    expect(addWorkingDays("2023-05-29", -1, WC5)).toBe("2023-05-26");
    expect(addWorkingDays("2023-05-27", 0, WC5)).toBe("2023-05-27");
  });

  it("C5: workingDaysBetween", () => {
    expect(workingDaysBetween("2023-05-22", "2023-06-02", WC5)).toBe(10);
    expect(workingDaysBetween("2023-05-22", "2023-06-02", WC0)).toBe(12);
    expect(workingDaysBetween("2023-05-27", "2023-05-28", WC5)).toBe(0);
    expect(workingDaysBetween("2023-05-26", "2023-05-22", WC5)).toBe(0);
    expect(durationOf("2023-05-22", "2023-06-02", WC5)).toBe(10);
  });

  it("C6: holidays are skipped", () => {
    const wc = compileCalendar({ weekends: [0, 6], holidays: ["2023-05-29"] });
    expect(nextWorkingDay("2023-05-27", wc)).toBe("2023-05-30");
    expect(isWorkingDay("2023-05-29", wc)).toBe(false);
  });

  it("C7: workingDayOffset", () => {
    expect(workingDayOffset("2023-05-26", "2023-05-29", WC5)).toBe(1);
    expect(workingDayOffset("2023-05-29", "2023-05-26", WC5)).toBe(-1);
    expect(workingDayOffset("2023-05-29", "2023-05-29", WC5)).toBe(0);
    // consistency with addWorkingDays for working-day endpoints
    expect(addWorkingDays("2023-05-23", workingDayOffset("2023-05-23", "2023-06-05", WC5), WC5)).toBe(
      "2023-06-05",
    );
  });

  it("C8: formatDuration (5-day week)", () => {
    expect([1, 5, 6, 0, 11].map((d) => formatDuration(d, WC5))).toEqual([
      "1d",
      "1w",
      "1w1d",
      "0d",
      "2w1d",
    ]);
    expect(formatDuration(-3, WC5)).toBe("0d");
  });

  it("C9: formatDuration (7-day week)", () => {
    expect(formatDuration(7, WC0)).toBe("1w");
    expect(formatDuration(12, WC0)).toBe("1w5d");
  });

  it("C10: parseDuration", () => {
    expect(parseDuration("1w2d", WC5)).toBe(7);
    expect(parseDuration(" 1W 2D ", WC5)).toBe(7);
    expect(parseDuration("3", WC5)).toBe(3);
    expect(parseDuration("2w", WC5)).toBe(10);
    expect(parseDuration("0d", WC5)).toBeNull();
    expect(parseDuration("abc", WC5)).toBeNull();
    expect(parseDuration("", WC5)).toBeNull();
  });

  it("C11: compileCalendar", () => {
    expect(compileCalendar(undefined)).toMatchObject({ enabled: false, daysPerWeek: 7 });
    expect(compileCalendar({ weekends: [0], holidays: [] }).daysPerWeek).toBe(6);
    expect(WC5.daysPerWeek).toBe(5);
  });

  it("C12: scanning is bounded (CALENDAR_NO_WORKING_DAY)", () => {
    const wc = compileCalendar({ weekends: [0, 1, 2, 3, 4, 5, 6] as unknown as [number], holidays: [] });
    expect(() => nextWorkingDay("2023-05-22", wc)).toThrow(CalendarError);
    expect(() => prevWorkingDay("2023-05-22", wc)).toThrow(CalendarError);
    expect(() => addWorkingDays("2023-05-22", 1, wc)).toThrow(CalendarError);
    expect(() => addWorkingDays("2023-05-22", -1, wc)).toThrow(CalendarError);
  });
});
