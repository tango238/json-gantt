import { isDragActive } from "../components/chart/useDrag";
import type { DialogIssue } from "../components/dialogs/SchemaErrorDialog";
import { showToast } from "../components/uiStore";
import { deepEqual, loadDocument, type LoadIssue } from "../engine";
import { dialogIssues, toDialogIssue } from "../app/fileActions";
import { t } from "../i18n";
import { idKey, newId } from "../model/id";
import type { GanttDocument } from "../model/types";
import { useAppStore } from "../store/appStore";
import { serialNosOf, treeIndexOf } from "../store/selectors";
import * as api from "../tauri/api";
import { onAiEvent } from "../tauri/events";
import { isTauri } from "../tauri/isTauri";
import { toAppError, type AiRunResult, type AppError } from "../tauri/types";
import { useAiStore, initialAiState } from "./aiStore";
import { parseLine } from "./parseStream";
import { buildSystemPrompt, buildUserPrompt, CARRY_OVER_DISCARDED, carryOverInvalid } from "./prompt";
import { summarizeChanges } from "./summarizeChanges";
import { nextMessageId } from "./transcript";
import type { ResultDetail, TurnOutcome } from "./types";

const ai = () => useAiStore.getState();
const app = () => useAppStore.getState();

async function quiet(f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch {
    /* best effort */
  }
}

/** Same document ignoring `view`. */
export function sameDocIgnoringView(a: GanttDocument, b: GanttDocument): boolean {
  return a === b || deepEqual({ ...a, view: undefined }, { ...b, view: undefined });
}

function addCard(runId: string, outcome: TurnOutcome, detail: ResultDetail): string {
  const id = nextMessageId();
  ai().pushMessage({ id, kind: "result", runId, outcome, detail });
  return id;
}

/** End of run `runId` (a no-op once reset() has replaced it). Tool rows still spinning are settled. */
function finish(runId: string): void {
  if (ai().runId !== runId) return;
  const ok = ai().lastResult?.ok === true;
  const messages = ai().messages.some((m) => m.kind === "tool" && m.state === "running")
    ? ai().messages.map((m) => (m.kind === "tool" && m.state === "running" ? { ...m, state: ok ? ("done" as const) : ("error" as const) } : m))
    : ai().messages;
  useAiStore.setState({ status: "idle", runId: null, messages });
}

/** The pending `aiReset` call; send() waits for it so a run never meets the session that reset() is deleting. */
let resetting: Promise<void> = Promise.resolve();

function metaOf(): ResultDetail {
  const r = ai().lastResult;
  if (r === null) return {};
  return {
    ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}),
    ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}),
    ...(r.numTurns !== null ? { numTurns: r.numTurns } : {}),
    permissionDenials: r.permissionDenials,
  };
}

function failReason(res: AiRunResult, stopped: boolean): NonNullable<ResultDetail["reason"]> {
  const r = ai().lastResult;
  if (stopped) return "stopped";
  if (res.exit.timedOut) return "timeout";
  if (r === null && res.exit.code !== null && res.exit.code !== 0) return "exitCode";
  return "turnError";
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

/** Feed one `ai-event` payload (lines of a run that is no longer current are dropped). */
export function handleAiEvent(p: { runId: string; line: string }): void {
  if (p.runId !== ai().runId) return;
  for (const ev of parseLine(p.line)) {
    if (ev.kind === "invalid" && import.meta.env?.DEV) console.warn("[ai] unparsable stream line", ev.line.slice(0, 200));
    ai().applyEvent(ev);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function markPendingDiscarded(): void {
  const s = ai();
  if (s.pendingCardId !== null) s.patchMessage(s.pendingCardId, { outcome: "discarded", detail: {} });
  useAiStore.setState({ pendingNext: null, pendingWarnings: [], pendingCardId: null });
}

export async function send(text: string): Promise<void> {
  if (!isTauri()) {
    showToast("info", t("toast.desktopOnly"));
    return;
  }
  const base = app().doc;
  if (base === null || ai().status !== "idle" || text.trim() === "") return;

  if (ai().pendingNext !== null) {
    markPendingDiscarded();
    useAiStore.setState({ carryOver: CARRY_OVER_DISCARDED });
  }

  const runId = newId();
  const baseLoadCount = app().loadCount;

  let selected = null;
  const selId = app().selectedId;
  const task = selId === null ? undefined : treeIndexOf(base).byId.get(idKey(selId));
  if (task !== undefined) selected = { rowNo: serialNosOf(base).get(idKey(task.id)) ?? 0, name: task.name, id: task.id };

  const prompt = buildUserPrompt(text, { selected, carryOver: ai().carryOver });
  const resumeSessionId = ai().sessionId;
  ai().startTurn();
  ai().pushMessage({ id: nextMessageId(), kind: "user", text });
  useAiStore.setState({ status: "running", runId, carryOver: null });

  let res: AiRunResult;
  try {
    await resetting;
    const info = await api.aiLocate();
    if (ai().runId !== runId) return; // reset() already ran
    if (ai().error !== null) useAiStore.setState({ error: null });
    if (ai().status === "stopping") {
      // [Stop] while the session was being located: nothing was started.
      addCard(runId, "noChange", { reason: "stopped" });
      finish(runId);
      return;
    }
    res = await api.aiRun({
      runId,
      document: base,
      prompt,
      appendSystemPrompt: buildSystemPrompt(info),
      resumeSessionId,
    });
  } catch (e) {
    if (ai().runId !== runId) return;
    const error = toAppError(e);
    if (error.kind === "AI_NOT_FOUND") useAiStore.setState({ error });
    addCard(runId, "failed", { error });
    finish(runId);
    return;
  }
  if (ai().runId !== runId) return; // reset() already ran
  try {
    if (app().loadCount !== baseLoadCount) return; // the document was reloaded; the subscription already reported it
    handleResult(runId, base, res);
    // A resume target that does not exist fails without ever sending `init`: forget it.
    if (resumeSessionId !== null && !ai().initSeen && !res.exit.stopped && !res.exit.timedOut && res.exit.code !== null && res.exit.code !== 0) {
      useAiStore.setState({ sessionId: null });
      ai().pushMessage({ id: nextMessageId(), kind: "notice", textKey: "ai.notice.newSession" });
    }
  } catch (e) {
    addCard(runId, "failed", { error: { kind: "INTERNAL", message: e instanceof Error ? e.message : String(e) } satisfies AppError });
  } finally {
    finish(runId);
  }
}

function handleResult(runId: string, base: GanttDocument, res: AiRunResult): void {
  // The result line is also delivered in the return value (event ordering is not guaranteed).
  if (ai().lastResult === null && res.lastResultLine !== null) {
    for (const ev of parseLine(res.lastResultLine)) ai().applyEvent(ev);
  }
  const last = ai().lastResult;
  // [Stop] pressed but the process still finished normally (it was not registered yet, or the exit raced it).
  const stopped = res.exit.stopped || ai().status === "stopping";
  const turnOk = last !== null && last.ok && !stopped && !res.exit.timedOut;
  const meta = metaOf();
  const file = res.file;

  const invalid = (issues: DialogIssue[]) => {
    addCard(runId, "invalid", { issues, ...meta });
    useAiStore.setState({ carryOver: carryOverInvalid(issues) });
  };

  switch (file.status) {
    case "unchanged":
      if (turnOk || stopped) {
        addCard(runId, "noChange", { ...meta, ...(stopped ? { reason: "stopped" as const } : {}) });
      } else {
        addCard(runId, "failed", {
          reason: failReason(res, stopped),
          ...meta,
          stderrTail: res.stderrTail,
          ...(res.exit.code !== null ? { exitCode: res.exit.code } : {}),
        });
      }
      return;
    case "missing":
      invalid([{ code: "AI_FILE_MISSING", path: "" }]);
      return;
    case "invalid":
      invalid(dialogIssues(file.error));
      return;
    case "changed": {
      const r = loadDocument(file.document as GanttDocument);
      if (!r.ok) {
        invalid(r.errors.map(toDialogIssue));
        return;
      }
      // A drag in progress would lose its preview when the document is replaced: ask the user instead.
      const docChanged = !sameDocIgnoringView(base, app().doc!) || isDragActive();
      if (turnOk && !docChanged) {
        importDoc(r.doc, r.warnings, runId, meta);
        return;
      }
      const cardId = addCard(runId, "pending", {
        reason: turnOk ? "docChanged" : failReason(res, stopped),
        ...meta,
        ...(res.exit.code !== null ? { exitCode: res.exit.code } : {}),
      });
      useAiStore.setState({ pendingNext: r.doc, pendingWarnings: r.warnings, pendingCardId: cardId });
    }
  }
}

/** Replace the document with `next` as one undo step; updates (or creates) the result card. */
function importDoc(
  next: GanttDocument,
  warnings: LoadIssue[],
  runId: string,
  meta: ResultDetail,
  cardId: string | null = null,
): void {
  const before = app().doc!;
  const res = app().dispatch({ type: "replaceDocument", doc: next });
  let outcome: TurnOutcome;
  let detail: ResultDetail;
  if (!res.ok) {
    outcome = "failed";
    detail = { error: { kind: "INTERNAL", message: res.code } satisfies AppError, ...meta };
  } else if (res.patches.length === 0) {
    outcome = "noChange";
    detail = { ...meta };
  } else {
    const stack = app().undoStack;
    outcome = "applied";
    detail = {
      ...meta,
      undoId: stack[stack.length - 1]!.id,
      summary: summarizeChanges(before, app().doc!),
      warnings: warnings.filter((w) => w.code !== "DEPENDENCY_VIOLATION"),
    };
  }
  if (cardId !== null) ai().patchMessage(cardId, { outcome, detail });
  else addCard(runId, outcome, detail);
  useAiStore.setState({ pendingNext: null, pendingWarnings: [], pendingCardId: null });
}

/** [Apply] on a pending card. */
export function applyPending(): void {
  const s = ai();
  if (s.pendingNext === null || s.pendingCardId === null || app().doc === null) return;
  const card = s.messages.find((m) => m.id === s.pendingCardId);
  const meta: ResultDetail = {};
  if (card?.kind === "result") {
    const { durationMs, costUsd, numTurns, permissionDenials } = card.detail;
    if (durationMs !== undefined) meta.durationMs = durationMs;
    if (costUsd !== undefined) meta.costUsd = costUsd;
    if (numTurns !== undefined) meta.numTurns = numTurns;
    if (permissionDenials !== undefined) meta.permissionDenials = permissionDenials;
  }
  importDoc(s.pendingNext, s.pendingWarnings, card?.kind === "result" ? card.runId : "", meta, s.pendingCardId);
}

/** [Discard] on a pending card. */
export function discard(): void {
  if (ai().pendingNext === null) return;
  markPendingDiscarded();
  useAiStore.setState({ carryOver: CARRY_OVER_DISCARDED });
}

export async function stop(): Promise<void> {
  if (ai().status !== "running") return;
  const runId = ai().runId;
  useAiStore.setState({ status: "stopping" });
  await quiet(() => api.aiStop(runId));
}

/** "New conversation". */
export function reset(noticeKey = "ai.notice.newSession"): Promise<void> {
  useAiStore.setState({
    ...initialAiState(),
    paneHeight: ai().paneHeight,
    collapsed: ai().collapsed,
    messages: [{ id: nextMessageId(), kind: "notice", textKey: noticeKey }],
  });
  resetting = quiet(() => api.aiReset());
  return resetting;
}

/** [Undo] on an applied card: only while that entry is still the top of the undo stack. */
export function canUndoTurn(undoId: number | undefined): boolean {
  const stack = app().undoStack;
  return undoId !== undefined && stack.length > 0 && stack[stack.length - 1]!.id === undoId;
}
export function undoTurn(undoId: number | undefined): boolean {
  if (!canUndoTurn(undoId)) return false;
  app().undo();
  return true;
}

/** Save the claude executable chosen by the user and clear the pane error. */
export async function setClaudePath(path: string): Promise<void> {
  try {
    await api.aiSetClaudePath(path);
    useAiStore.setState({ error: null });
  } catch (e) {
    useAiStore.setState({ error: toAppError(e) });
  }
}
export const dismissError = (): void => useAiStore.setState({ error: null });

// ---------------------------------------------------------------------------
// Wiring (document switches, ai-event subscription)
// ---------------------------------------------------------------------------

/** Called when a document is (re)loaded into the window (06 section 4.7). */
function onDocumentLoaded(sameFile: boolean): void {
  if (!sameFile) {
    void reset("ai.notice.documentChanged");
    return;
  }
  const s = ai();
  if (s.status === "running") {
    useAiStore.setState({ status: "stopping" });
    void quiet(() => api.aiStop(s.runId));
  }
  if (s.pendingNext !== null) markPendingDiscarded();
  s.pushMessage({ id: nextMessageId(), kind: "notice", textKey: "ai.notice.reloaded" });
}

/**
 * Starts watching the document store and the `ai-event` stream. Call once at startup; call the
 * returned function to stop.
 */
export function initAiActions(): () => void {
  const unsub = useAppStore.subscribe((s, prev) => {
    if (s.loadCount === prev.loadCount) return;
    const sameFile = s.doc !== null && s.filePath !== null && s.filePath === prev.filePath;
    onDocumentLoaded(sameFile);
  });
  let unlisten: (() => void) | null = null;
  let disposed = false;
  if (isTauri()) {
    void onAiEvent(handleAiEvent).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
  }
  return () => {
    disposed = true;
    unsub();
    unlisten?.();
  };
}
