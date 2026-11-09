import { t } from "../i18n";

export interface RecentFile {
  path: string;
  name: string;
}

interface Props {
  onNew?: () => void;
  onOpen?: () => void;
  /** Up to 10 entries are shown. */
  recentFiles?: readonly RecentFile[];
  onOpenRecent?: (path: string) => void;
}

/** Shown while no document is open (03 section 13). WP10 wires the callbacks. */
export function EmptyState({ onNew, onOpen, recentFiles = [], onOpenRecent }: Props) {
  const recent = recentFiles.slice(0, 10);
  return (
    <div className="empty-state" data-testid="empty-state">
      <h1>{t("app.name")}</h1>
      <div className="empty-actions">
        <button type="button" className="primary" disabled={!onOpen} onClick={onOpen}>
          {t("empty.open")}
        </button>
        <button type="button" disabled={!onNew} onClick={onNew}>
          {t("empty.new")}
        </button>
      </div>
      {recent.length > 0 && (
        <div className="empty-recent">
          <h2>{t("empty.recent")}</h2>
          <ul>
            {recent.map((f) => (
              <li key={f.path}>
                <button type="button" title={f.path} onClick={() => onOpenRecent?.(f.path)}>
                  <span className="recent-name">{f.name}</span>
                  <span className="recent-path">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="empty-hint">{t("empty.dropHint")}</p>
    </div>
  );
}
