import { describe, expect, it } from "vitest";
import sample from "../../../../schema/examples/sample.json";
import { compileCalendar, deriveAll, loadDocument } from "../../../engine";
import { t } from "../../../i18n";
import type { GanttDocument, Zoom } from "../../../model/types";
import { doc as mkDoc, task } from "../../../engine/__tests__/fixtures";
import { findViolations } from "../../../engine";
import { dateAtX, computeLayout, computeRange, xOfDate } from "../layout";

const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
if (!r.ok) throw new Error("sample invalid");
const doc = r.doc;
const wc = compileCalendar(doc.project.calendar);
const derived = deriveAll(doc, wc);
const TODAY = "2023-05-22";
const INITIATION = "1a95";

function layout(zoom: Zoom, collapsed: string[] = [], valueColumn: "duration" | "hours" = "duration") {
  return computeLayout({ doc, derived, wc, zoom, collapsed: new Set(collapsed), valueColumn }, TODAY);
}
const idStartingWith = (p: string) => doc.tasks.find((t) => t.id.startsWith(p))!.id;

describe("computeLayout (sample, day zoom)", () => {
  const l = layout("day");
  it("range, widths, rows", () => {
    expect(l.range.start).toBe("2023-05-15");
    expect(l.dayWidth).toBe(68);
    expect(l.rows).toHaveLength(31);
    expect(l.rows[0]!.y).toBe(0);
    expect(l.rows[5]!.y).toBe(130);
    expect(l.rows[5]!.rowNo).toBe(6);
    expect(l.bodyHeight).toBe(31 * 26);
    expect(xOfDate(l, "2023-05-22")).toBe(476);
    expect(dateAtX(l, 476 + 10)).toBe("2023-05-22");
    expect(l.todayX).toBe(476);
  });
  it("bars", () => {
    const goals = l.bars[2]!;
    expect(goals.kind).toBe("leaf");
    expect(goals.x).toBe(476);
    expect(goals.w).toBe(68);
    expect(goals.y).toBe(2 * 26 + 5);
    const plan = l.bars[0]!;
    expect(plan.kind).toBe("summary");
    expect(plan.x).toBe(476);
    expect(plan.w).toBe(12 * 68);
  });
  it("arrow with detour (Define goals -> Kickoff meeting)", () => {
    const a = l.arrows.find((x) => x.succId.startsWith("4613") && x.predId.startsWith("4652"))!;
    expect(a.d).toBe("M 544 65 H 552 V 104 H 536 V 117 H 544");
    expect(a.head).toBe("544,117 538,113.5 538,120.5");
    expect(a.violated).toBe(false);
  });
  it("direct arrow when there is enough room (UI mockups -> Database design, across a weekend)", () => {
    const a = l.arrows.find((x) => x.succId.startsWith("d0d4") && x.predId.startsWith("31ca"))!;
    const y1 = a.fromIndex * 26 + 13;
    const y2 = a.toIndex * 26 + 13;
    expect(a.d).toBe(`M 816 ${y1} H 824 V ${y2} H 952`);
    expect(a.head).toBe(`952,${y2} 946,${y2 - 3.5} 946,${y2 + 3.5}`);
  });
  it("header cells", () => {
    expect(l.headerTop[0]!.w).toBe(476);
    expect(l.headerTop[0]!.label).toBe(t("header.weekRange", { year: 2023, from: t("header.monthDay", { month: 5, day: 15 }), to: t("header.monthDay", { month: 5, day: 21 }) }));
    expect(l.headerBottom[7]!.label).toBe(`22 (${t("weekday.1")})`);
    expect(l.headerBottom[5]!.muted).toBe(true);
    expect(l.nonWorking[0]).toEqual({ x: 5 * 68, w: 2 * 68 });
  });
  it("value column", () => {
    expect(l.rows[2]!.valueText).toBe("1d");
    const h = layout("day", [], "hours");
    expect(h.rows[2]!.valueText).toBe("8h");
  });
});

describe("computeLayout (other zooms)", () => {
  it("week: bottom cell width 140, top = months", () => {
    const l = layout("week");
    expect(l.dayWidth).toBe(20);
    expect(l.headerBottom[0]!.w).toBe(140);
    expect(l.headerBottom[0]!.label).toBe("5/15–5/21");
    expect(l.headerTop[0]!.label).toBe(t("header.month", { year: 2023, month: 5 }));
    expect(l.headerTop[0]!.w).toBe(17 * 20); // 5/15..5/31 clipped at range start
  });
  it("month: range snaps to month boundaries, header year/month", () => {
    const l = layout("month");
    expect(l.range.start).toBe("2023-05-01");
    expect(l.range.end.endsWith("-31") || l.range.end.endsWith("-30")).toBe(true);
    expect(l.headerBottom[0]).toMatchObject({ x: 0, w: 31 * 6, label: t("header.monthShort", { month: 5 }) });
    expect(l.headerTop[0]!.label).toBe(t("header.year", { year: 2023 }));
    expect(l.nonWorking).toEqual([]);
  });
});

describe("collapse", () => {
  const initiation = idStartingWith(INITIATION);
  const l = layout("day", [initiation]);
  it("hides children", () => {
    expect(l.rows).toHaveLength(26);
    expect(l.rows[1]!.collapsed).toBe(true);
    expect(l.rows[2]!.name).toBe("Planning");
    // serial number among all tasks, unaffected by collapsing
    expect(l.rows[2]!.rowNo).toBe(derived.order.indexOf(l.rows[2]!.taskId) + 1);
    expect(l.rows[2]!.rowNo).toBeGreaterThan(3);
  });
  it("arrows to hidden tasks attach to the collapsed ancestor; internal ones vanish", () => {
    // Requirements gathering depends on Kickoff meeting (child of Initiation)
    const a = l.arrows.find((x) => x.succId.startsWith("3cb7") && x.predId.startsWith("4613"))!;
    expect(a.fromIndex).toBe(1);
    expect(l.arrows.some((x) => x.succId.startsWith("4613"))).toBe(false);
    for (const x of l.arrows) expect(x.fromIndex).not.toBe(x.toIndex);
  });
});

function layoutOf(d: GanttDocument, zoom: Zoom, extra: { collapsed?: string[]; prev?: ReturnType<typeof computeLayout> } = {}) {
  const w = compileCalendar(d.project.calendar);
  return computeLayout(
    { doc: d, derived: deriveAll(d, w), wc: w, zoom, collapsed: new Set(extra.collapsed ?? []), valueColumn: "duration" },
    TODAY,
    extra.prev,
  );
}

describe("non-working bands", () => {
  it("weekends form bands; an adjacent holiday merges into the weekend band", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" })]);
    expect(layoutOf(d, "day").nonWorking[0]).toEqual({ x: 5 * 68, w: 2 * 68 });
    const h = { ...d, project: { ...d.project, calendar: { weekends: [0, 6], holidays: ["2023-05-22", "2023-05-15"] } } };
    const l = layoutOf(h as GanttDocument, "day");
    expect(l.nonWorking[0]).toEqual({ x: 0, w: 68 }); // holiday on the first day of the range
    expect(l.nonWorking[1]).toEqual({ x: 5 * 68, w: 3 * 68 }); // Sat, Sun, holiday Monday
  });
  it("a trailing non-working run at the range end is closed; none without a calendar", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22" })]);
    const l = layoutOf(d, "day");
    const last = l.nonWorking[l.nonWorking.length - 1]!;
    expect(last.x + last.w).toBe(l.timelineWidth); // range ends on a Sunday
    expect(layoutOf(mkDoc([task({ id: "A", start: "2023-05-22" })], { calendar: false }), "day").nonWorking).toEqual([]);
  });
});

describe("violated dependency arrows", () => {
  it("marks an arrow whose successor starts before the predecessor ends", () => {
    const d = mkDoc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-24" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
      task({ id: "C", start: "2023-05-26", deps: ["A"] }),
    ]);
    expect(findViolations(d, compileCalendar(d.project.calendar))).toHaveLength(1);
    const l = layoutOf(d, "day");
    expect(l.arrows.find((a) => a.succId === "B")!.violated).toBe(true);
    expect(l.arrows.find((a) => a.succId === "C")!.violated).toBe(false);
  });
});

describe("month / week boundaries", () => {
  const sum = (cells: { w: number }[]) => cells.reduce((a, c) => a + c.w, 0);
  it("month zoom: range snaps to month start / end across a year boundary", () => {
    const d = mkDoc([task({ id: "A", start: "2023-12-20", end: "2024-01-10" })]);
    const l = layoutOf(d, "month");
    expect(l.range.start).toBe("2023-12-01"); // 12-20 minus 7 days
    expect(l.range.end).toBe("2024-03-31"); // 01-10 plus 60 days = 03-10 -> month end
    expect(sum(l.headerBottom)).toBe(l.timelineWidth);
    expect(sum(l.headerTop)).toBe(l.timelineWidth);
    expect(l.headerTop.map((c) => c.label)).toEqual([t("header.year", { year: 2023 }), t("header.year", { year: 2024 })]);
    expect(l.headerTop[0]!.w).toBe(31 * 6);
    expect(l.headerBottom).toHaveLength(4);
  });
  it("week zoom: months are clipped at the range edges and cells tile the width", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-31", end: "2023-06-02" })]);
    const l = layoutOf(d, "week");
    expect(l.range.start).toBe("2023-05-22"); // Monday on/before 05-24
    expect(l.range.end).toBe("2023-07-02"); // Sunday on/after 06-30
    expect(l.headerBottom).toHaveLength(6);
    expect(sum(l.headerBottom)).toBe(l.timelineWidth);
    expect(sum(l.headerTop)).toBe(l.timelineWidth);
    expect(l.headerTop[0]!.w).toBe(10 * 20); // 05-22..05-31
    expect(l.headerTop[1]!.w).toBe(30 * 20); // 06-01..06-30
    expect(l.headerTop[2]!.w).toBe(2 * 20); // 07-01..07-02
  });
  it("computeRange falls back to today without tasks", () => {
    const d = mkDoc([]);
    const r = computeRange(deriveAll(d, compileCalendar(d.project.calendar)), "day", TODAY);
    expect(r.start).toBe("2023-05-15");
    expect(r.end).toBe("2023-06-25");
  });
});

describe("reference stability (prev layout)", () => {
  it("same input -> identical layout, rows, bars and arrows", () => {
    const a = layout("day");
    const b = computeLayout(
      { doc, derived, wc, zoom: "day", collapsed: new Set(), valueColumn: "duration" },
      TODAY,
      a,
    );
    expect(b).toBe(a);
  });
  it("a changed task keeps the references of unchanged rows / bars", () => {
    const d = mkDoc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-29" }),
      task({ id: "C", start: "2023-05-30" }),
    ]);
    const a = layoutOf(d, "day");
    const moved = {
      ...d,
      tasks: d.tasks.map((x) => (x.id === "C" ? { ...x, start: "2023-05-31", end: "2023-05-31" } : x)),
    } as GanttDocument;
    const b = layoutOf(moved, "day", { prev: a });
    expect(b).not.toBe(a);
    expect(b.rows).toBe(a.rows); // names / values unchanged
    expect(b.bars).not.toBe(a.bars);
    expect(b.bars[0]).toBe(a.bars[0]);
    expect(b.bars[1]).toBe(a.bars[1]);
    expect(b.bars[2]).not.toBe(a.bars[2]);
    expect(b.headerBottom).toBe(a.headerBottom);
    expect(b.nonWorking).toBe(a.nonWorking);
  });
});
