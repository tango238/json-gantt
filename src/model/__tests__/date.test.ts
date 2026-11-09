import { describe, expect, it } from "vitest";
import { addDays, dayOfWeek, diffDays, fromEpochDay, isValidIsoDate, toEpochDay } from "../date";
import { idKey, newId } from "../id";

describe("date", () => {
  it("toEpochDay", () => {
    expect(toEpochDay("1970-01-01")).toBe(0);
    expect(toEpochDay("1969-12-31")).toBe(-1);
    expect(toEpochDay("2000-03-01")).toBe(11017);
  });
  it("fromEpochDay round trips", () => {
    for (let n = -700000; n < 2900000; n += 997) expect(toEpochDay(fromEpochDay(n))).toBe(n);
    expect(fromEpochDay(0)).toBe("1970-01-01");
  });
  it("addDays", () => {
    expect(addDays("2023-05-31", 1)).toBe("2023-06-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
    expect(addDays("2023-01-01", -1)).toBe("2022-12-31");
    expect(addDays("2023-05-22", 0)).toBe("2023-05-22");
  });
  it("diffDays", () => {
    expect(diffDays("2023-05-22", "2023-06-02")).toBe(11);
    expect(diffDays("2023-06-02", "2023-05-22")).toBe(-11);
  });
  it("dayOfWeek", () => {
    expect(dayOfWeek("2023-05-22")).toBe(1);
    expect(dayOfWeek("2023-05-21")).toBe(0);
    expect(dayOfWeek("2023-05-27")).toBe(6);
    expect(dayOfWeek("1969-12-31")).toBe(3);
  });
  it("isValidIsoDate", () => {
    expect(isValidIsoDate("2023-02-30")).toBe(false);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2023-02-29")).toBe(false);
    expect(isValidIsoDate("2023-13-01")).toBe(false);
    expect(isValidIsoDate("2023-1-01")).toBe(false);
    expect(isValidIsoDate("2023-05-22")).toBe(true);
  });
  it("id helpers", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idKey("ABC-DEF")).toBe("abc-def");
  });
});
