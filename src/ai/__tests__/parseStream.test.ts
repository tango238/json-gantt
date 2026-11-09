import { describe, expect, it } from "vitest";
import { parseLine } from "../parseStream";
import { fixtureLines } from "./fixtures";

const SID = "bdd5bdc5-8d12-4181-b34a-e70717bf6318";

describe("parseStream", () => {
  it("P1: probe.jsonl parses into the expected event sequence", () => {
    const events = fixtureLines("probe").flatMap(parseLine);
    expect(events.map((e) => e.kind)).toEqual([
      "init", "text", "toolUse", "rateLimit", "toolResult", "toolUse", "rateLimit", "toolResult", "text", "result",
    ]);
    expect(events[0]).toMatchObject({ kind: "init", sessionId: SID, tools: ["Edit", "Read"] });
    expect(events[2]).toMatchObject({ kind: "toolUse", name: "Read", filePath: "/tmp/json-gantt-ai-x/t.json" });
    expect(events[3]).toEqual({ kind: "rateLimit", status: "allowed" });
    expect(events[5]).toMatchObject({ kind: "toolUse", name: "Edit" });
    expect(events[4]).toMatchObject({ kind: "toolResult", isError: false });
    expect(events[8]).toEqual({ kind: "text", text: "DONE" });
    const r = events[9]!;
    expect(r).toMatchObject({
      kind: "result", ok: true, subtype: "success", sessionId: SID, text: "DONE",
      durationMs: 7628, numTurns: 3, permissionDenials: 0,
    });
    expect((r as { costUsd: number }).costUsd).toBeCloseTo(0.1125, 4);
  });

  it("P2: invalid JSON, blank lines, unknown types and sub-agent lines never throw", () => {
    const events = fixtureLines("garbage").flatMap((l) => parseLine(l));
    expect(events.filter((e) => e.kind === "invalid")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "ignored").length).toBeGreaterThanOrEqual(5);
    expect(events.some((e) => e.kind === "text")).toBe(false);
    expect(parseLine("")).toEqual([{ kind: "ignored" }]);
    expect(parseLine("null")).toEqual([{ kind: "ignored" }]);
    expect(parseLine('{"type":"system","subtype":"hook"}')).toEqual([{ kind: "ignored" }]);
    expect(parseLine('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}')).toEqual([
      { kind: "ignored" },
    ]);
    expect(parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"  "}]}}')).toEqual([
      { kind: "ignored" },
    ]);
  });

  // NOTE: fixtures/error-result.jsonl is hand-written (subtype "error_during_execution" is an assumed value,
  // not captured from a real claude run); only "not success / is_error" matters here.
  it("P3: result is not ok when subtype != success or is_error", () => {
    const [bad] = fixtureLines("error-result").flatMap(parseLine);
    expect(bad).toMatchObject({ kind: "result", ok: false, subtype: "error_during_execution", sessionId: SID });
    const [flag] = parseLine('{"type":"result","subtype":"success","is_error":true}');
    expect(flag).toMatchObject({ ok: false, sessionId: null, text: null, costUsd: null, permissionDenials: 0 });
    const [odd] = parseLine('{"type":"rate_limit_event"}');
    expect(odd).toEqual({ kind: "rateLimit", status: "unknown" });
  });

  it("parses multiple blocks of one line in order and tool_result errors", () => {
    const evs = parseLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "Edit", input: {} }] },
      }),
    );
    expect(evs).toEqual([
      { kind: "text", text: "a" },
      { kind: "toolUse", toolUseId: "t1", name: "Edit", filePath: null },
    ]);
    const [tr] = fixtureLines("tool-error").flatMap(parseLine).filter((e) => e.kind === "toolResult");
    expect(tr).toMatchObject({ isError: true });
  });
});
