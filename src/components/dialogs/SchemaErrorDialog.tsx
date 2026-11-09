import { t, type Params } from "../../i18n";
import { showToast } from "../uiStore";
import { Modal } from "./Modal";

export interface DialogIssue {
  /** Issue code (same as engine LoadIssue / Rust Issue): looked up as error.schema.<code>, error.load.<code>, error.warning.<code>. */
  code: string;
  /** JSON pointer (shown in monospace). */
  path: string;
  params?: Params;
  /** Fallback message (e.g. English text from Rust) when no translation exists. */
  message?: string;
}

interface Props {
  /** Defaults to the "cannot open file" title; pass t("dialog.warningsTitle") for load warnings. */
  title?: string;
  filePath?: string | null;
  issues: readonly DialogIssue[];
  onClose: () => void;
}

export const MAX_ISSUES = 200;

/** Localised message of one issue. */
export function issueMessage(i: DialogIssue): string {
  for (const ns of ["schema", "load", "warning"]) {
    const key = `error.${ns}.${i.code}`;
    const s = t(key, i.params);
    if (s !== key) return s;
  }
  return i.message ?? i.code;
}

/** Root pointer "" is shown as "/". */
export const issuePath = (i: DialogIssue): string => (i.path === "" ? t("dialog.issuePath") : i.path);

export function issuesToText(filePath: string | null | undefined, issues: readonly DialogIssue[]): string {
  const lines = issues.map((i) => `${issuePath(i)}\t${issueMessage(i)}`);
  return (filePath ? [filePath, ...lines] : lines).join("\n");
}

/** List of schema/load errors or load warnings (03 section 11.1, 11.5). Display only. */
export function SchemaErrorDialog({ title, filePath, issues, onClose }: Props) {
  const shown = issues.slice(0, MAX_ISSUES);
  const rest = issues.length - shown.length;
  const copy = () => {
    void Promise.resolve(navigator.clipboard?.writeText(issuesToText(filePath, issues)))
      .then(() => showToast("info", t("toast.copied")))
      .catch(() => undefined);
  };
  return (
    <Modal
      title={title ?? t("dialog.schemaErrorTitle")}
      wide
      onCancel={onClose}
      actions={
        <>
          <button type="button" onClick={copy}>
            {t("dialog.copy")}
          </button>
          <button type="button" onClick={onClose} data-autofocus>
            {t("dialog.close")}
          </button>
        </>
      }
    >
      {filePath && <p className="modal-path">{filePath}</p>}
      <ul className="issue-list">
        {shown.map((i, n) => (
          <li key={n}>
            <code>{issuePath(i)}</code>
            <span>{issueMessage(i)}</span>
          </li>
        ))}
        {rest > 0 && <li className="issue-more">{t("dialog.more", { count: rest })}</li>}
      </ul>
    </Modal>
  );
}
