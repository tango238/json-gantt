import { formatDuration, getDerived, parseDuration } from "../../engine";
import { t } from "../../i18n";
import { idKey } from "../../model/id";
import { useAppStore } from "../../store/appStore";
import { calendarOf, derivedOf, displayDoc, treeIndexOf } from "../../store/selectors";
import { runCommand } from "../actions";
import { CommitInput } from "./fields";
import { ProgressField } from "./ProgressField";
import { PredecessorEditor } from "./PredecessorEditor";

const HOURS_RE = /^\d+(\.\d+)?$/;
const DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;
const validYear = (v: string): boolean => {
  const m = DATE_RE.exec(v);
  return m !== null && Number(m[1]) >= 1900 && Number(m[1]) <= 2999;
};

/** Task detail editor (03 section 9.1). */
export function TasksTab() {
  const doc = useAppStore(displayDoc);
  const selectedId = useAppStore((s) => s.selectedId);
  if (!doc || selectedId === null) return <p className="panel-empty">{t("panel.noSelection")}</p>;
  const task = treeIndexOf(doc).byId.get(idKey(selectedId));
  const dt = getDerived(derivedOf(doc), selectedId);
  if (!task || !dt) return <p className="panel-empty">{t("panel.noSelection")}</p>;

  const wc = calendarOf(doc);
  const id = task.id;
  const isParent = dt.isParent;
  const derivedNote = isParent ? t("panel.derived") : undefined;
  const resources = doc.resources ?? [];
  const labels = doc.colorLabels ?? [];
  const checked = new Set((task.resourceIds ?? []).map(idKey));

  return (
    <div className="panel-form" key={id}>
      <label className="field">
        <span>{t("panel.name")}</span>
        <CommitInput
          value={task.name}
          testId="panel-name"
          commit={(v) => {
            if (v.trim() === "") return false;
            return runCommand({ type: "setName", id, name: v }).ok;
          }}
        />
      </label>

      <ProgressField taskId={id} progress={Math.round(dt.progress)} disabled={isParent} note={derivedNote} />

      <label className="field">
        <span>{t("panel.hours")}</span>
        <CommitInput
          type="number"
          extra={{ min: 0, step: 0.5 }}
          value={dt.hours === undefined ? "" : String(dt.hours)}
          disabled={isParent}
          testId="panel-hours"
          commit={(v) => {
            const s = v.trim();
            if (s === "") return runCommand({ type: "setHours", id, hours: null }).ok;
            if (!HOURS_RE.test(s)) return false;
            return runCommand({ type: "setHours", id, hours: Number(s) }).ok;
          }}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>{t("panel.start")}</span>
          <CommitInput
            type="date"
            value={dt.start}
            disabled={isParent}
            testId="panel-start"
            commitOnChange={validYear}
            commit={(v) => validYear(v) && runCommand({ type: "setDates", id, start: v, end: dt.end }).ok}
          />
        </label>
        <label className="field">
          <span>{t("panel.end")}</span>
          <CommitInput
            type="date"
            value={dt.end}
            disabled={isParent}
            testId="panel-end"
            commitOnChange={validYear}
            commit={(v) => validYear(v) && runCommand({ type: "setDates", id, start: dt.start, end: v }).ok}
          />
        </label>
      </div>

      <label className="field">
        <span>{t("panel.duration")}</span>
        <CommitInput
          value={formatDuration(dt.durationDays, wc)}
          disabled={isParent}
          testId="panel-duration"
          commit={(v) => {
            const days = parseDuration(v, wc);
            if (days === null) return false;
            return runCommand({ type: "setDuration", id, days }).ok;
          }}
        />
      </label>

      <fieldset className="field">
        <legend>{t("panel.resources")}</legend>
        {resources.map((r) => (
          <label key={r.id} className="check">
            <input
              type="checkbox"
              checked={checked.has(idKey(r.id))}
              onChange={(e) => {
                const next = resources
                  .filter((x) => (idKey(x.id) === idKey(r.id) ? e.target.checked : checked.has(idKey(x.id))))
                  .map((x) => x.id);
                runCommand({ type: "setResources", id, resourceIds: next });
              }}
            />
            <span className="chip" style={{ background: r.color ?? "#9ca3af" }} />
            {r.name}
          </label>
        ))}
        {isParent && <small className="note">{t("panel.resourcesPropagate")}</small>}
      </fieldset>

      <fieldset className="field">
        <legend>{t("panel.colorLabel")}</legend>
        <div className="swatches">
          <button
            type="button"
            className={`swatch none${task.colorLabelId === undefined ? " selected" : ""}`}
            onClick={() => runCommand({ type: "setColorLabel", id, colorLabelId: null })}
          >
            {t("panel.colorLabelNone")}
          </button>
          {labels.map((l) => (
            <button
              key={l.id}
              type="button"
              title={l.name}
              aria-label={l.name}
              className={`swatch${task.colorLabelId !== undefined && idKey(task.colorLabelId) === idKey(l.id) ? " selected" : ""}`}
              style={{ background: l.color }}
              onClick={() => runCommand({ type: "setColorLabel", id, colorLabelId: l.id })}
            />
          ))}
        </div>
      </fieldset>

      <PredecessorEditor taskId={id} />

      <label className="field">
        <span>{t("panel.notes")}</span>
        <CommitInput
          multiline
          rows={4}
          value={task.notes ?? ""}
          testId="panel-notes"
          commit={(v) => {
            return runCommand({ type: "setNotes", id, notes: v }).ok;
          }}
        />
      </label>
    </div>
  );
}
