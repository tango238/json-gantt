import type { DialogIssue } from "../components/dialogs/SchemaErrorDialog";
import type { LoadIssue } from "../engine";
import type { Params } from "../i18n";
import type { AppError } from "../tauri/types";
import type { ChangeSummary } from "./summarizeChanges";

export type AiStatus = "idle" | "running" | "stopping";

export type TurnOutcome = "applied" | "noChange" | "pending" | "discarded" | "invalid" | "failed";

export interface ResultDetail {
  reason?: "stopped" | "timeout" | "turnError" | "docChanged" | "exitCode";
  summary?: ChangeSummary;
  issues?: DialogIssue[];
  warnings?: LoadIssue[];
  undoId?: number;
  error?: AppError;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
  permissionDenials?: number;
  stderrTail?: string;
  exitCode?: number;
}

export type AiMessage =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | {
      id: string;
      kind: "tool";
      toolUseId: string;
      name: string;
      target: string | null;
      state: "running" | "done" | "error";
    }
  | { id: string; kind: "result"; runId: string; outcome: TurnOutcome; detail: ResultDetail }
  | { id: string; kind: "notice"; textKey: string; params?: Params };

export const MAX_MESSAGES = 500;
