import { describe, expect, it } from "vitest";
import sample from "../../../schema/examples/sample.json";
import { loadDocument } from "../../engine";
import type { GanttDocument } from "../../model/types";
import { formatSummary, summarizeChanges } from "../summarizeChanges";

const base = (() => {
  const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
  if (!r.ok) throw new Error("sample");
  return r.doc;
})();
const clone = () => structuredClone(base);
const tr = (k: string, p?: Record<string, string | number>) => (p ? `${k}${JSON.stringify(p)}` : k);

describe("summarizeChanges", () => {
  it("S1: identical documents give all zeros and 'none'", () => {
    const s = summarizeChanges(base, clone());
    expect(s).toMatchObject({
      tasksAdded: 0, tasksRemoved: 0, tasksChanged: 0, tasksReordered: false, project: false, calendar: false,
      other: false, resources: { added: 0, removed: 0, changed: 0 }, colorLabels: { added: 0, removed: 0, changed: 0 },
    });
    expect(formatSummary(s, tr)).toBe("ai.summary.none");
    expect(formatSummary(s)).not.toBe("ai.summary.none"); // default translator resolves ja.json
  });

  it("S2: added / removed / changed tasks and reorder-only", () => {
    const d = clone();
    const leaves = d.tasks.filter((t) => t.start !== undefined);
    const removed = d.tasks.splice(d.tasks.indexOf(leaves[0]!), 1)[0]!;
    d.tasks.push({ ...structuredClone(removed), id: "11111111-1111-4111-8111-111111111111", parentId: null, dependencies: [] });
    leaves[1]!.name = "renamed";
    leaves[2]!.end = "2030-01-01";
    const s = summarizeChanges(base, d);
    expect(s).toMatchObject({ tasksAdded: 1, tasksRemoved: 1, tasksChanged: 2 });
    expect(s.addedTaskIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(s.changedTaskIds).toEqual([leaves[1]!.id, leaves[2]!.id]);
    const text = formatSummary(s, tr);
    expect(text).toContain('ai.summary.tasksAdded{"count":1}');
    expect(text).toContain('ai.summary.tasksChanged{"count":2}');

    const swapped = clone();
    [swapped.tasks[0], swapped.tasks[1]] = [swapped.tasks[1]!, swapped.tasks[0]!];
    const r = summarizeChanges(base, swapped);
    expect(r).toMatchObject({ tasksAdded: 0, tasksRemoved: 0, tasksChanged: 0, tasksReordered: true });
    expect(formatSummary(r, tr)).toBe("ai.summary.tasksReordered");
  });

  it("S3: resources, color labels, calendar and other keys", () => {
    const d = clone();
    d.resources = [...(d.resources ?? []), { id: "22222222-2222-4222-8222-222222222222", name: "New" }];
    d.colorLabels = d.colorLabels!.map((c, i) => (i === 0 ? { ...c, name: "renamed" } : c));
    d.project.calendar = { weekends: [0], holidays: ["2030-01-01"] };
    (d as Record<string, unknown>)["x-new"] = 1;
    const s = summarizeChanges(base, d);
    expect(s.resources).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(s.colorLabels).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(s).toMatchObject({ project: true, calendar: true, projectInfo: false, other: true });
    const text = formatSummary(s, tr);
    expect(text).toContain("ai.summary.calendar");
    expect(text).not.toContain("ai.summary.project");
    expect(text).toContain("ai.summary.other");

    const e = clone();
    e.project.name = "Other name";
    e.resources = [];
    e.colorLabels = [];
    const s2 = summarizeChanges(base, e);
    expect(s2).toMatchObject({ project: true, calendar: false, projectInfo: true });
    expect(s2.resources.removed).toBe(base.resources!.length);
    const t2 = formatSummary(s2, tr);
    expect(t2).toContain("ai.summary.project");
    expect(t2).toContain("ai.summary.resourcesRemoved");
    expect(t2).toContain("ai.summary.colorLabelsRemoved");
  });

  it("S4: ids differing only in case are the same task", () => {
    const d = clone();
    d.tasks = d.tasks.map((t) => ({
      ...t,
      id: t.id.toUpperCase(),
      parentId: t.parentId == null ? null : t.parentId.toUpperCase(),
      dependencies: t.dependencies?.map((x) => ({ ...x, predecessorId: x.predecessorId.toUpperCase() })),
    }));
    const s = summarizeChanges(base, d);
    expect(s.tasksAdded).toBe(0);
    expect(s.tasksRemoved).toBe(0);
    expect(s.tasksReordered).toBe(false);
  });

  it("S5: a derived parent period change is not counted as a parent change; violations are reported", () => {
    const d = clone();
    const leaf = d.tasks.find((t) => t.start !== undefined && t.parentId !== null)!;
    leaf.end = "2031-01-01"; // parents derive from children; their stored JSON has no dates
    const s = summarizeChanges(base, d);
    expect(s.tasksChanged).toBe(1);
    expect(s.changedTaskIds).toEqual([leaf.id]);

    const v = clone();
    const dep = v.tasks.find((t) => (t.dependencies?.length ?? 0) > 0 && t.start !== undefined)!;
    dep.start = "2000-01-01";
    dep.end = "2000-01-01";
    const sv = summarizeChanges(base, v);
    expect(sv.violations).toBeGreaterThan(0);
    expect(formatSummary(sv, tr)).toContain("ai.summary.violations");
  });
});
