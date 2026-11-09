import { produce } from "immer";
import { useEffect, useRef, useState } from "react";
import { getDerived } from "../../engine";
import { t } from "../../i18n";
import { idKey } from "../../model/id";
import { useAppStore } from "../../store/appStore";
import { derivedOf } from "../../store/selectors";
import { runCommand } from "../actions";
import { useNativeChange } from "./fields";

/**
 * Progress slider: while dragging only a preview document is shown; releasing the thumb
 * (native `change`) dispatches setProgress once, so one Undo reverts it.
 */
export function ProgressField({
  taskId,
  progress,
  disabled,
  note,
}: {
  taskId: string;
  progress: number;
  disabled: boolean;
  note?: string;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const shown = drag ?? progress;

  // Never leave a preview behind if the field unmounts mid-drag.
  useEffect(
    () => () => {
      if (draggingRef.current) useAppStore.getState().clearPreview();
    },
    [],
  );

  const ref = useNativeChange<HTMLInputElement>((raw) => {
    const value = Math.round(Number(raw));
    const s = useAppStore.getState();
    draggingRef.current = false;
    s.clearPreview();
    setDrag(null);
    if (!Number.isFinite(value) || !s.doc) return;
    // Compare against the committed document, not the preview.
    const committed = getDerived(derivedOf(s.doc), taskId);
    if (committed && Math.round(committed.progress) !== value) {
      runCommand({ type: "setProgress", id: taskId, progress: value });
    }
  });

  return (
    <label className="field">
      <span>
        {t("panel.progress")} {note && <small className="note">({note})</small>}
      </span>
      <div className="slider-row">
        <input
          ref={ref}
          type="range"
          min={0}
          max={100}
          step={1}
          value={shown}
          disabled={disabled}
          data-testid="panel-progress"
          onChange={(e) => {
            const value = Number(e.target.value);
            setDrag(value);
            draggingRef.current = true;
            const s = useAppStore.getState();
            if (s.doc) {
              s.setPreview(
                produce(s.doc, (d) => {
                  const task = d.tasks.find((x) => idKey(x.id) === idKey(taskId));
                  if (task) task.progress = value;
                }),
              );
            }
          }}
        />
        <output>{shown}%</output>
      </div>
    </label>
  );
}
