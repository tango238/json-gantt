import type { ResultEvent, StreamEvent } from "./parseStream";
import { MAX_MESSAGES, type AiMessage } from "./types";

/** Conversation state that stream events fold into. */
export interface TranscriptState {
  messages: AiMessage[];
  sessionId: string | null;
  /** Result event of the turn in progress (consumed by aiActions when the run ends). */
  lastResult: ResultEvent | null;
  rateLimitNoticed: boolean;
  /** The `init` event of the turn in progress has arrived (a `--resume` that fails never sends it). */
  initSeen: boolean;
}

export const emptyTranscript = (): TranscriptState => ({
  messages: [],
  sessionId: null,
  lastResult: null,
  rateLimitNoticed: false,
  initSeen: false,
});

let seq = 0;
export const nextMessageId = (): string => `m${++seq}`;

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function appendMessage(messages: readonly AiMessage[], m: AiMessage): AiMessage[] {
  const next = [...messages, m];
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

/** Reset the per-turn fields at the start of a turn. */
export const beginTurn = (s: TranscriptState): TranscriptState => ({ ...s, lastResult: null, rateLimitNoticed: false, initSeen: false });

export function applyStreamEvent(s: TranscriptState, ev: StreamEvent): TranscriptState {
  switch (ev.kind) {
    case "init":
      return { ...s, sessionId: ev.sessionId, initSeen: true };
    case "text":
      if (ev.text.trim() === "") return s;
      return { ...s, messages: appendMessage(s.messages, { id: nextMessageId(), kind: "assistant", text: ev.text }) };
    case "toolUse":
      return {
        ...s,
        messages: appendMessage(s.messages, {
          id: nextMessageId(),
          kind: "tool",
          toolUseId: ev.toolUseId,
          name: ev.name,
          target: ev.filePath === null ? null : baseName(ev.filePath),
          state: "running",
        }),
      };
    case "toolResult": {
      const i = s.messages.findIndex((m) => m.kind === "tool" && m.toolUseId === ev.toolUseId);
      if (i < 0) return s;
      const messages = s.messages.slice();
      messages[i] = { ...(messages[i] as Extract<AiMessage, { kind: "tool" }>), state: ev.isError ? "error" : "done" };
      return { ...s, messages };
    }
    case "result":
      return { ...s, lastResult: ev, sessionId: ev.sessionId ?? s.sessionId };
    case "rateLimit":
      if (ev.status === "allowed" || s.rateLimitNoticed) return s;
      return {
        ...s,
        rateLimitNoticed: true,
        messages: appendMessage(s.messages, {
          id: nextMessageId(),
          kind: "notice",
          textKey: "ai.notice.rateLimit",
          params: { status: ev.status },
        }),
      };
    case "ignored":
    case "invalid":
      return s;
  }
}
