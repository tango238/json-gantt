import { create } from "zustand";
import type { LoadIssue } from "../engine";
import type { GanttDocument } from "../model/types";
import type { AppError } from "../tauri/types";
import type { StreamEvent } from "./parseStream";
import {
  appendMessage,
  applyStreamEvent,
  beginTurn,
  emptyTranscript,
  nextMessageId,
  type TranscriptState,
} from "./transcript";
import type { AiMessage, AiStatus } from "./types";

export type { AiMessage, AiStatus, ResultDetail, TurnOutcome } from "./types";

export const DEFAULT_PANE_HEIGHT = 240;

export interface AiState extends TranscriptState {
  status: AiStatus;
  /** Run in progress (routes ai-event lines). */
  runId: string | null;
  /** Candidate waiting for [apply] / [discard] (latest only). */
  pendingNext: GanttDocument | null;
  pendingWarnings: LoadIssue[];
  /** Message id of the pending result card. */
  pendingCardId: string | null;
  /** One-shot context line for the next prompt. */
  carryOver: string | null;
  /** Persistent pane error (AI_NOT_FOUND etc.). */
  error: AppError | null;
  paneHeight: number;
  collapsed: boolean;

  pushMessage(m: AiMessage): void;
  patchMessage(id: string, patch: Partial<Extract<AiMessage, { kind: "result" }>>): void;
  applyEvent(ev: StreamEvent): void;
  startTurn(): void;
  setPaneHeight(h: number): void;
  setCollapsed(c: boolean): void;
}

export const initialAiState = () => ({
  ...emptyTranscript(),
  status: "idle" as AiStatus,
  runId: null as string | null,
  pendingNext: null as GanttDocument | null,
  pendingWarnings: [] as LoadIssue[],
  pendingCardId: null as string | null,
  carryOver: null as string | null,
  error: null as AppError | null,
  paneHeight: DEFAULT_PANE_HEIGHT,
  collapsed: false,
});

export const useAiStore = create<AiState>()((set) => ({
  ...initialAiState(),
  pushMessage: (m) => set((s) => ({ messages: appendMessage(s.messages, m) })),
  patchMessage: (id, patch) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id && m.kind === "result" ? { ...m, ...patch } : m)) })),
  applyEvent: (ev) => set((s) => applyStreamEvent(s, ev)),
  startTurn: () => set((s) => beginTurn(s)),
  setPaneHeight: (h) => set({ paneHeight: h }),
  setCollapsed: (c) => set({ collapsed: c }),
}));

/** Test helper / full reset of the conversation and pane state. */
export function resetAiStore(): void {
  useAiStore.setState(initialAiState());
}

export { nextMessageId };
