import { useState } from "react";
import { t } from "../../i18n";
import { idKey } from "../../model/id";
import type { Task } from "../../model/types";
import { useAppStore } from "../../store/appStore";
import { displayDoc } from "../../store/selectors";
import { requestConfirm } from "../uiStore";
import { runCommand } from "../actions";
import { ColorInput } from "./ColorInput";
import { CommitInput } from "./fields";

const DEFAULT_LABEL_COLOR = "#4A90D9";
const FALLBACK_RESOURCE_COLOR = "#9CA3AF";

/** Project settings (03 section 9.2). */
export function ProjectTab() {
  const doc = useAppStore(displayDoc);
  const [holiday, setHoliday] = useState("");
  if (!doc) return null;
  const cal = doc.project.calendar;
  const weekends: number[] = cal ? [...cal.weekends] : [];
  const holidays = cal?.holidays ?? [];
  const setCalendar = (weekendList: number[], holidayList: string[]) =>
    runCommand({
      type: "setCalendar",
      calendar: { weekends: weekendList as NonNullable<typeof cal>["weekends"], holidays: holidayList },
    });
  const usage = (pick: (task: Task) => boolean) => doc.tasks.filter(pick).length;

  return (
    <div className="panel-form">
      <label className="field">
        <span>{t("panel.projectName")}</span>
        <CommitInput
          value={doc.project.name}
          testId="project-name"
          commit={(v) => {
            return runCommand({ type: "setProjectInfo", name: v }).ok;
          }}
        />
      </label>
      <label className="field">
        <span>{t("panel.description")}</span>
        <CommitInput
          multiline
          rows={3}
          value={doc.project.description ?? ""}
          commit={(v) => {
            return runCommand({ type: "setProjectInfo", description: v }).ok;
          }}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={cal !== undefined}
          data-testid="use-calendar"
          onChange={(e) =>
            runCommand({
              type: "setCalendar",
              calendar: e.target.checked ? { weekends: [0, 6], holidays: [] } : null,
            })
          }
        />
        {t("panel.useCalendar")}
      </label>

      {cal !== undefined && (
        <>
          <fieldset className="field">
            <legend>{t("panel.weekends")}</legend>
            <div className="weekdays">
              {[0, 1, 2, 3, 4, 5, 6].map((w) => {
                const on = weekends.includes(w);
                return (
                  <label key={w} className="check">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && weekends.length >= 6}
                      onChange={(e) =>
                        setCalendar(
                          e.target.checked ? [...weekends, w].sort() : weekends.filter((x) => x !== w),
                          holidays,
                        )
                      }
                    />
                    {t(`weekday.${w}`)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend>{t("panel.holidays")}</legend>
            {holidays.length === 0 && <small className="note">{t("panel.noHolidays")}</small>}
            <ul className="holiday-list">
              {[...holidays].sort().map((h) => (
                <li key={h}>
                  <span>{h.replace(/-/g, "/")}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("panel.remove")}
                    aria-label={t("panel.remove")}
                    onClick={() =>
                      setCalendar(
                        [...weekends],
                        holidays.filter((x) => x !== h),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="pred-add">
              <input
                type="date"
                value={holiday}
                aria-label={t("panel.holidayDate")}
                onChange={(e) => setHoliday(e.target.value)}
              />
              <button
                type="button"
                disabled={!/^(19|2\d)\d{2}-\d{2}-\d{2}$/.test(holiday)}
                onClick={() => {
                  if (setCalendar([...weekends], [...holidays, holiday]).ok) setHoliday("");
                }}
              >
                {t("panel.addHoliday")}
              </button>
            </div>
          </fieldset>
        </>
      )}

      <fieldset className="field">
        <legend>{t("panel.resourceList")}</legend>
        {(doc.resources ?? []).map((r) => (
          <div key={r.id} className="list-row">
            <ColorInput
              value={r.color ?? FALLBACK_RESOURCE_COLOR}
              label={t("panel.color")}
              onCommit={(color) => runCommand({ type: "updateResource", id: r.id, color })}
            />
            {r.color !== undefined && (
              <button
                type="button"
                className="icon-btn"
                title={t("panel.clearColor")}
                aria-label={t("panel.clearColor")}
                onClick={() => runCommand({ type: "updateResource", id: r.id, color: null })}
              >
                ○
              </button>
            )}
            <CommitInput
              value={r.name}
              ariaLabel={t("panel.resourceName")}
              commit={(v) => {
                if (v.trim() === "") return false;
                return runCommand({ type: "updateResource", id: r.id, name: v }).ok;
              }}
            />
            <button
              type="button"
              className="icon-btn"
              title={t("panel.delete")}
              aria-label={t("panel.delete")}
              onClick={() => {
                const count = usage((x) => (x.resourceIds ?? []).some((i) => idKey(i) === idKey(r.id)));
                const del = () => {
                  runCommand({ type: "deleteResource", id: r.id });
                };
                if (count === 0) del();
                else
                  requestConfirm({
                    message: t("dialog.confirmDeleteResource", { name: r.name, count }),
                    confirmLabel: t("dialog.delete"),
                    onConfirm: del,
                  });
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="add-btn"
          onClick={() => runCommand({ type: "addResource", name: t("panel.newResourceName") })}
        >
          {t("panel.addResource")}
        </button>
      </fieldset>

      <fieldset className="field">
        <legend>{t("panel.colorLabelList")}</legend>
        {(doc.colorLabels ?? []).map((l) => (
          <div key={l.id} className="list-row">
            <ColorInput
              value={l.color}
              label={t("panel.color")}
              onCommit={(color) => runCommand({ type: "updateColorLabel", id: l.id, color })}
            />
            <CommitInput
              value={l.name}
              ariaLabel={t("panel.colorLabelName")}
              commit={(v) => {
                if (v.trim() === "") return false;
                return runCommand({ type: "updateColorLabel", id: l.id, name: v }).ok;
              }}
            />
            <button
              type="button"
              className="icon-btn"
              title={t("panel.delete")}
              aria-label={t("panel.delete")}
              onClick={() => {
                const count = usage((x) => x.colorLabelId !== undefined && idKey(x.colorLabelId) === idKey(l.id));
                const del = () => {
                  runCommand({ type: "deleteColorLabel", id: l.id });
                };
                if (count === 0) del();
                else
                  requestConfirm({
                    message: t("dialog.confirmDeleteColorLabel", { name: l.name, count }),
                    confirmLabel: t("dialog.delete"),
                    onConfirm: del,
                  });
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="add-btn"
          onClick={() =>
            runCommand({ type: "addColorLabel", name: t("panel.newColorLabelName"), color: DEFAULT_LABEL_COLOR })
          }
        >
          {t("panel.addColorLabel")}
        </button>
      </fieldset>
    </div>
  );
}
