/** Shapes of the Rust side (04-backend: error.rs, fileio.rs, commands/*). */

export interface RustIssue {
  path: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

export type AppError =
  | { kind: "IO"; message: string; path?: string }
  | { kind: "PARSE_ERROR"; message: string; line: number; column: number }
  | { kind: "UNSUPPORTED_VERSION"; found: number; supported: number }
  | { kind: "SCHEMA_INVALID"; errors: RustIssue[] }
  | { kind: "PDF"; message: string }
  | { kind: "INTERNAL"; message: string }
  | { kind: "AI"; message: string }
  | { kind: "AI_NOT_FOUND"; searched: string[] };

export interface OpenResult {
  document: unknown;
  warnings: RustIssue[];
}

export interface RecentFileEntry {
  path: string;
  name: string;
}

/** AI pane (06-ai-pane section 5). Field names are camelCase on the wire. */
export interface AiSessionInfo {
  claudePath: string;
  dir: string;
  ganttPath: string;
  schemaPath: string;
}
export interface AiExit {
  code: number | null;
  stopped: boolean;
  timedOut: boolean;
}
export type AiFileResult =
  | { status: "unchanged" }
  | { status: "missing" }
  | { status: "changed"; document: unknown; warnings: RustIssue[] }
  | { status: "invalid"; error: AppError };
export interface AiRunResult {
  runId: string;
  exit: AiExit;
  stderrTail: string;
  lastResultLine: string | null;
  file: AiFileResult;
}
export interface AiRunArgs {
  runId: string;
  document: unknown;
  prompt: string;
  appendSystemPrompt: string;
  resumeSessionId: string | null;
}
export interface AiEventPayload {
  runId: string;
  line: string;
}

export type ExternalChangeKindEvent = "modified" | "removed";
export interface FileChangedPayload {
  path: string;
  kind: ExternalChangeKindEvent;
}
export interface OpenFileRequestedPayload {
  path: string;
}
export type MenuActionName = "new" | "open" | "save" | "saveAs" | "exportPdf" | "undo" | "redo";
export interface MenuActionPayload {
  action: MenuActionName;
}

const KINDS = ["IO", "PARSE_ERROR", "UNSUPPORTED_VERSION", "SCHEMA_INVALID", "PDF", "INTERNAL", "AI", "AI_NOT_FOUND"];

/** Normalises whatever `invoke` rejected with into an AppError. */
export function toAppError(e: unknown): AppError {
  if (typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string") {
    if (KINDS.includes((e as { kind: string }).kind)) return e as AppError;
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return { kind: "INTERNAL", message };
}

/** Short human readable text of an AppError (for toasts). */
export function errorText(e: AppError): string {
  switch (e.kind) {
    case "IO":
    case "PDF":
    case "INTERNAL":
    case "AI":
      return e.message;
    case "AI_NOT_FOUND":
      return `claude not found (searched: ${e.searched.join(", ")})`;
    case "PARSE_ERROR":
      return `${e.message} (${e.line}:${e.column})`;
    case "UNSUPPORTED_VERSION":
      return `version ${e.found} > ${e.supported}`;
    case "SCHEMA_INVALID":
      return e.errors[0]?.message ?? e.kind;
  }
}
