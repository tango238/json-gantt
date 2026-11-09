import { describe, expect, it } from "vitest";
import { parseLine } from "../parseStream";
import { appendMessage, applyStreamEvent, beginTurn, emptyTranscript, type TranscriptState } from "../transcript";
import { MAX_MESSAGES } from "../types";
import { fixtureLines } from "./fixtures";

const fold = (lines: string[], s: TranscriptState = emptyTranscript()) =>
  lines.flatMap(parseLine).reduce(applyStreamEvent, s);

describe("transcript", () => {
  it("P4: probe.jsonl folds into assistant / tool / tool / assistant and keeps the session id", () => {
    const s = fold(fixtureLines("probe"));
    expect(s.messages).toMatchObject([
      { kind: "assistant" },
      { kind: "tool", name: "Read", target: "t.json", state: "done" },
      { kind: "tool", name: "Edit", target: "t.json", state: "done" },
      { kind: "assistant", text: "DONE" },
    ]);
    expect(s.sessionId).toBe("bdd5bdc5-8d12-4181-b34a-e70717bf6318");
    expect(s.lastResult).toMatchObject({ ok: true });
  });

  it("P5: an errored tool_result marks the tool row as error; an orphan tool_result is ignored", () => {
    const s = fold(fixtureLines("tool-error"));
    expect(s.messages.filter((m) => m.kind === "tool")).toMatchObject([{ name: "Edit", state: "error" }]);
    const before = fold(fixtureLines("probe"));
    const after = applyStreamEvent(before, { kind: "toolResult", toolUseId: "nope", isError: true });
    expect(after).toBe(before);
    const denied = fold(fixtureLines("permission-denied"));
    expect(denied.messages.filter((m) => m.kind === "tool")).toMatchObject([
      { target: "outside.txt", state: "error" },
      { target: "t.json", state: "done" },
      { target: "t.json", state: "done" },
    ]);
    expect(denied.lastResult?.permissionDenials).toBe(1);
  });

  it("P6: a rate-limit notice appears once per turn and only for non-allowed status", () => {
    let s = emptyTranscript();
    s = applyStreamEvent(s, { kind: "rateLimit", status: "allowed" });
    expect(s.messages).toEqual([]);
    s = applyStreamEvent(s, { kind: "rateLimit", status: "allowed_warning" });
    s = applyStreamEvent(s, { kind: "rateLimit", status: "rejected" });
    expect(s.messages).toMatchObject([{ kind: "notice", textKey: "ai.notice.rateLimit", params: { status: "allowed_warning" } }]);
    s = applyStreamEvent(beginTurn(s), { kind: "rateLimit", status: "rejected" });
    expect(s.messages).toHaveLength(2);
    expect(beginTurn(s).lastResult).toBeNull();
  });

  it("ignores blank text, init without model, invalid and ignored events; caps the list", () => {
    const s = emptyTranscript();
    expect(applyStreamEvent(s, { kind: "text", text: "  " })).toBe(s);
    expect(applyStreamEvent(s, { kind: "ignored" })).toBe(s);
    expect(applyStreamEvent(s, { kind: "invalid", line: "x" })).toBe(s);
    let list = [] as ReturnType<typeof appendMessage>;
    for (let i = 0; i < MAX_MESSAGES + 5; i++) list = appendMessage(list, { id: `x${i}`, kind: "user", text: "" });
    expect(list).toHaveLength(MAX_MESSAGES);
    expect(list[0]!.id).toBe("x5");
    const t = applyStreamEvent(s, { kind: "toolUse", toolUseId: "a", name: "Read", filePath: null });
    expect(t.messages[0]).toMatchObject({ target: null });
    const r = applyStreamEvent({ ...s, sessionId: "old" }, { kind: "result", ok: true, subtype: "success", sessionId: null, text: null, costUsd: null, durationMs: null, numTurns: null, permissionDenials: 0 });
    expect(r.sessionId).toBe("old");
  });
});
