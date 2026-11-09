import { t } from "../../i18n";

interface Props {
  count: number;
  onDetails: () => void;
  onDismiss: () => void;
}

/** Yellow banner above the chart for load warnings (03 section 11.5). */
export function WarningsBanner({ count, onDetails, onDismiss }: Props) {
  if (count <= 0) return null;
  return (
    <div className="warnings-banner" role="status">
      <span>{t("dialog.warningsBanner", { count })}</span>
      <button type="button" onClick={onDetails}>
        {t("dialog.details")}
      </button>
      <button type="button" aria-label={t("dialog.close")} onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
