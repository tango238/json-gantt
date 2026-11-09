import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { applyPending, canUndoTurn, discard, undoTurn } from "../../ai/aiActions";
import type { AiMessage } from "../../ai/types";
import { formatSummary } from "../../ai/summarizeChanges";
import { t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { errorText, type AppError } from "../../tauri/types";
import { issueMessage, issuePath, SchemaErrorDialog } from "../dialogs/SchemaErrorDialog";

type ResultMsg = Extract<AiMessage, { kind: "result" }>;
const MAX_SHOWN_ISSUES = 5;

function Meta({ d }: { d: ResultMsg["detail"] }) {
  const parts: string[] = [];
  if (d.durationMs !== undefined) parts.push(t("ai.meta.duration", { seconds: (d.durationMs / 1000).toFixed(1) }));
  if (d.permissionDenials) parts.push(t("ai.meta.denials", { count: d.permissionDenials }));
  if (parts.length === 0 && d.costUsd === undefined) return null;
  return (
    <div className="ai-meta">
      {parts.join(" \u30fb ")}
      {d.costUsd !== undefined && (
        <span title={t("ai.meta.costHint")}>
          {parts.length > 0 ? " \u30fb " : ""}
          {t("ai.meta.cost", { cost: d.costUsd.toFixed(2) })}
        </span>
      )}
    </div>
  );
}

/** Failed-card message in Japanese (errorText is English-only). */
function failedMessage(d: ResultMsg["detail"]): string {
  const e: AppError | undefined = d.error;
  if (!e) return reasonText(d);
  if (e.kind === "AI_NOT_FOUND") return t("ai.notFound");
  if (e.kind === "AI") return t("ai.error.spawn", { message: e.message });
  return errorText(e);
}

/** [undo] button; re-renders only when its own enabled state flips. */
function UndoButton({ undoId }: { undoId: number | undefined }) {
  const enabled = useAppStore(() => canUndoTurn(undoId));
  return (
    <button type="button" disabled={!enabled} onClick={() => undoTurn(undoId)} title={t("ai.undo")}>
      {t("ai.undo")}
    </button>
  );
}

function reasonText(d: ResultMsg["detail"]): string {
  return t(`ai.failedReason.${d.reason ?? "turnError"}`, { code: d.exitCode ?? "" });
}

/** Outcome of one turn (06 section 4.8). */
export function ResultCard({ msg }: { msg: ResultMsg }) {
  const { outcome, detail: d } = msg;
  const [showDialog, setShowDialog] = useState(false);
  const [showWarn, setShowWarn] = useState(false);
  const [showStderr, setShowStderr] = useState(false);

  let body: ReactNode;
  switch (outcome) {
    case "applied": {
      const warnings = d.warnings ?? [];
      body = (
        <>
          <div className="ai-card-line">
            <span>{d.summary ? formatSummary(d.summary) : t("ai.outcome.applied")}</span>
            <UndoButton undoId={d.undoId} />
          </div>
          {warnings.length > 0 && (
            <div>
              <button type="button" className="ai-link" onClick={() => setShowWarn((v) => !v)}>
                {t("ai.warnings", { count: warnings.length })}
              </button>
              {showWarn && (
                <ul className="ai-issues">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      <code>{issuePath(w)}</code> {issueMessage(w)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      );
      break;
    }
    case "noChange":
      body = <div>{d.reason === "stopped" ? t("ai.outcome.stopped") : t("ai.outcome.noChange")}</div>;
      break;
    case "discarded":
      body = <div>{t("ai.outcome.discarded")}</div>;
      break;
    case "pending":
      body = (
        <>
          <div>{t(`ai.pending.${d.reason ?? "turnError"}`)}</div>
          <div className="ai-card-actions">
            <button type="button" onClick={applyPending} title={t("ai.pending.apply")}>
              {t("ai.pending.apply")}
            </button>
            <button type="button" onClick={discard} title={t("ai.pending.discard")}>
              {t("ai.pending.discard")}
            </button>
          </div>
        </>
      );
      break;
    case "invalid": {
      const issues = d.issues ?? [];
      const shown = issues.slice(0, MAX_SHOWN_ISSUES);
      body = (
        <>
          <div className="ai-card-line">
            <span>{t("ai.outcome.invalid")}</span>
            {issues.length > 0 && (
              <button type="button" onClick={() => setShowDialog(true)} title={t("ai.details")}>
                {t("ai.details")}
              </button>
            )}
          </div>
          <ul className="ai-issues">
            {shown.map((i, n) => (
              <li key={n}>
                <code>{issuePath(i)}</code> {issueMessage(i)}
              </li>
            ))}
            {issues.length > shown.length && <li>{t("ai.more", { count: issues.length - shown.length })}</li>}
          </ul>
          {showDialog &&
            createPortal(
              <SchemaErrorDialog title={t("ai.outcome.invalid")} issues={issues} onClose={() => setShowDialog(false)} />,
              document.body,
            )}
        </>
      );
      break;
    }
    case "failed": {
      const message = failedMessage(d);
      body = (
        <>
          <div>{t("ai.outcome.failed", { message })}</div>
          {d.stderrTail && (
            <div>
              <button type="button" className="ai-link" onClick={() => setShowStderr((v) => !v)}>
                {t("ai.stderr")}
              </button>
              {showStderr && <pre className="ai-stderr">{d.stderrTail}</pre>}
            </div>
          )}
        </>
      );
      break;
    }
  }
  return (
    <div className={`ai-card ai-card-${outcome}`}>
      {body}
      <Meta d={d} />
    </div>
  );
}
