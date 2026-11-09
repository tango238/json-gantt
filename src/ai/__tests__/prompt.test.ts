import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, carryOverInvalid, CARRY_OVER_DISCARDED } from "../prompt";

describe("prompt", () => {
  it("A11: the user prompt never starts with '-' and reflects the selection", () => {
    const none = buildUserPrompt("- do it", { selected: null, carryOver: null });
    expect(none.startsWith("-")).toBe(false);
    expect(none.startsWith("[アプリからの文脈]")).toBe(true);
    expect(none).toContain("選択中のタスク: なし");
    expect(none.endsWith("[ユーザーの依頼]\n- do it")).toBe(true);

    const sel = buildUserPrompt("go", { selected: { rowNo: 5, name: "a\nb  c", id: "id-1" }, carryOver: CARRY_OVER_DISCARDED });
    expect(sel).toContain("選択中のタスク: #5 a b c（id: id-1）");
    expect(sel).toContain(`- ${CARRY_OVER_DISCARDED}`);
    expect(sel.startsWith("-")).toBe(false);
  });

  it("A11: the system prompt embeds both paths in all places and has 14 rules", () => {
    const s = buildSystemPrompt({ ganttPath: "/tmp/x/gantt.json", schemaPath: "/tmp/x/schema.json" });
    expect(s).not.toContain("{ganttPath}");
    expect(s).not.toContain("{schemaPath}");
    expect(s.split("/tmp/x/gantt.json").length - 1).toBe(3);
    expect(s).toContain("- スキーマ（参照のみ、編集禁止）: /tmp/x/schema.json");
    expect(s).toMatch(/\n14\. ユーザーが『#5』/);
    expect(s).not.toMatch(/\n15\. /);
  });

  it("carry-over lines list at most 10 issues", () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ path: `/tasks/${i}`, code: "X" }));
    const text = carryOverInvalid(issues);
    expect(text.split("\n")).toHaveLength(11);
    expect(text).toContain("/tasks/9 X");
    expect(text).not.toContain("/tasks/10 X");
    expect(carryOverInvalid([{ path: "", code: "AI_FILE_MISSING" }])).toContain("\n  AI_FILE_MISSING");
  });
});
