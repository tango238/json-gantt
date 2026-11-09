import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sample from "../../../schema/examples/sample.json";
import { loadDocument } from "../../engine";
import type { GanttDocument } from "../../model/types";
import { composeSvg } from "../composeSvg";

const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
if (!r.ok) throw new Error("sample invalid");
const doc = r.doc;
const TODAY = "2023-05-22";
const PAGE_AW = 1133.85;
const PAGE_AH = 785.19;

const OUT = "/private/tmp/claude-501/-Users-go-work-github-json-gantt/283e0613-ff1f-46dd-ad90-3c9f88059114/scratchpad";

describe("composeSvg (sample, day zoom)", () => {
  const out = composeSvg({ doc, valueColumn: "duration", today: TODAY });
  const root = out.svg.match(/^<svg[^>]*>/)![0];

  it("root size", () => {
    // tight range 05-21..06-03 = 14 days at 68px: fits one A3 page at scale 0.75
    expect(out.width).toBe(330 + 14 * 68);
    expect((PAGE_AW / out.width >= 0.75) && (PAGE_AH / out.height >= 0.75)).toBe(true);
    expect(out.height).toBe(40 + 48 + 31 * 26);
    expect(out.height).toBe(894);
    expect(root).toContain(`width="${out.width}"`);
    expect(root).toContain('height="894"');
    expect(root).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(root).toContain('font-family="Noto Sans JP"');
  });
  it("excludes screen-only content", () => {
    expect(out.svg).not.toContain("rgba(");
    expect(out.svg).not.toContain("today-line");
    expect(out.svg).not.toContain("#EF4444");
    expect(out.svg).not.toContain("#1D4ED8"); // selection colour
    expect(out.svg).not.toContain("<image");
    expect(out.svg).not.toContain("transparent");
    expect(out.svg).not.toContain("-apple-system");
  });
  it("contains the table, title band and bars", () => {
    expect(out.svg).toContain(doc.project.name);
    expect(out.svg).toContain("2023/05/");
    expect(out.svg).toContain("Define goals");
    expect(out.svg).toContain("data-kind=\"summary\"");
  });
  it("reflects collapse and zoom", () => {
    const id = doc.tasks.find((x) => x.id.startsWith("1a95"))!.id;
    const c = structuredClone(doc);
    c.view = { ...c.view, collapsedTaskIds: [id] };
    expect(composeSvg({ doc: c, valueColumn: "duration", today: TODAY }).height).toBe(40 + 48 + 26 * 26);
    const w = structuredClone(doc);
    w.view = { ...w.view, zoom: "week" };
    // week: Monday 05-22 .. Sunday 06-04 = 14 days at 20px
    expect(composeSvg({ doc: w, valueColumn: "duration", today: TODAY }).width).toBe(330 + 14 * 20);
  });
  it("long tasks widen the figure (split across pages by the Rust side)", () => {
    const l = structuredClone(doc);
    const leaf = l.tasks.find((x) => !l.tasks.some((y) => y.parentId === x.id))!;
    leaf.end = "2023-08-31";
    expect(composeSvg({ doc: l, valueColumn: "duration", today: TODAY }).width).toBeGreaterThan(330 + 60 * 68);
  });
  it("writes a sample for visual checks", () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/wp9-sample.svg`, out.svg);
  });
});
