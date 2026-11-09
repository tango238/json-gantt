import { t } from "../i18n";
import { useAppStore } from "../store/appStore";
import { selectZoom } from "../store/selectors";
import type { Zoom } from "../model/types";

const ITEMS: { zoom: Zoom; key: string }[] = [
  { zoom: "day", key: "toolbar.zoomDay" },
  { zoom: "week", key: "toolbar.zoomWeek" },
  { zoom: "month", key: "toolbar.zoomMonth" },
];

/** Day / week / month segmented control (03 section 8.1, 8.3). */
export function ZoomSwitch() {
  const zoom = useAppStore(selectZoom);
  const setZoom = useAppStore((s) => s.setZoom);
  return (
    <div className="zoom-switch" role="group">
      {ITEMS.map((it) => (
        <button
          key={it.zoom}
          type="button"
          className={it.zoom === zoom ? "active" : ""}
          aria-pressed={it.zoom === zoom}
          onClick={() => setZoom(it.zoom)}
        >
          {t(it.key)}
        </button>
      ))}
    </div>
  );
}
