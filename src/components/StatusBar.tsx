import { t } from "../i18n";
import { useAppStore } from "../store/appStore";
import { calendarOf, derivedOf, displayDoc, selectViolations } from "../store/selectors";
import { runCommand } from "./actions";
import { statusTexts } from "./statusText";

/** Bottom status bar (03 section 10). */
export function StatusBar() {
  const doc = useAppStore(displayDoc);
  const selectedId = useAppStore((s) => s.selectedId);
  const violations = useAppStore(selectViolations);
  if (!doc) return <div className="status-inner" />;
  const s = statusTexts(doc, derivedOf(doc), calendarOf(doc), selectedId);
  const items = [s.tasks, s.hours, s.duration, s.progress];
  if (s.selectionName !== "") items.push(s.selectionName, s.selectionRange);
  return (
    <div className="status-inner">
      {items.map((text, i) => (
        <span key={i} className="status-item">
          {text}
        </span>
      ))}
      <span className="status-spacer" />
      {violations.length > 0 && (
        <span className="status-violation" data-testid="status-violations">
          <span aria-hidden="true">⚠</span> {t("status.violations", { count: violations.length })}
          <button type="button" onClick={() => runCommand({ type: "rescheduleAll" })}>
            {t("status.reschedule")}
          </button>
        </span>
      )}
    </div>
  );
}
