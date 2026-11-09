import { describe, expect, it } from "vitest";
import sample from "../../../schema/examples/sample.json";
import { loadDocument, projectProgress, formatDuration } from "../../engine";
import type { GanttDocument } from "../../model/types";
import { calendarOf, derivedOf } from "../../store/selectors";
import { statusTexts } from "../statusText";

function load(): GanttDocument {
  const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
  if (!r.ok) throw new Error("sample failed to load");
  return r.doc;
}

describe("statusTexts(sample)", () => {
  const doc = load();
  const derived = derivedOf(doc);
  const wc = calendarOf(doc);

  it("counts tasks, hours and duration", () => {
    const s = statusTexts(doc, derived, wc, null);
    const leafHours = doc.tasks
      .filter((x) => !doc.tasks.some((c) => c.parentId === x.id))
      .reduce((a, x) => a + (x.hours ?? 0), 0);
    expect(s.tasks).toBe("タスク: 31");
    expect(s.hours).toBe(`工数: ${leafHours}h`);
    expect(s.hours).toBe("工数: 214h");
    expect(s.duration).toBe("期間: 2w");
    expect(s.selectionName).toBe("");
    expect(s.selectionRange).toBe("");
  });

  it("formats project progress with 2 decimals", () => {
    const s = statusTexts(doc, derived, wc, null);
    expect(s.progress).toBe(`進捗: ${projectProgress(derived).toFixed(2)}%`);
  });

  it("describes the selected task", () => {
    const first = doc.tasks[0]!;
    const s = statusTexts(doc, derived, wc, first.id);
    const d = derived.byId.get(first.id.toLowerCase())!;
    expect(s.selectionName).toBe(first.name);
    expect(s.selectionRange).toBe(
      `${d.start.replace(/-/g, "/")} – ${d.end.replace(/-/g, "/")} (${formatDuration(d.durationDays, wc)})`,
    );
  });

  it("shows '-' for hours when no task has hours, and handles an empty project", () => {
    const empty: GanttDocument = { version: 1, project: { name: "x" }, tasks: [] };
    const s = statusTexts(empty, derivedOf(empty), calendarOf(empty), null);
    expect(s.tasks).toBe("タスク: 0");
    expect(s.hours).toBe("工数: -");
    expect(s.duration).toBe("期間: -");
    expect(s.progress).toBe("進捗: 0.00%");
  });
});
