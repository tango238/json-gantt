import { useMemo, useState } from "react";
import { getAncestors, getDescendants } from "../../engine";
import { t } from "../../i18n";
import { idKey } from "../../model/id";
import { useAppStore } from "../../store/appStore";
import { derivedOf, displayDoc, serialNosOf, treeIndexOf } from "../../store/selectors";
import { runCommand } from "../actions";
import { CommitInput } from "./fields";

/**
 * Predecessor list + add form (03 section 9.1). Candidates exclude the task itself, its
 * ancestors / descendants and existing predecessors; cycles are rejected by the engine (toast).
 */
export function PredecessorEditor({ taskId }: { taskId: string }) {
  const doc = useAppStore(displayDoc);
  const [pick, setPick] = useState("");
  const [lag, setLag] = useState("0");
  const ix = useMemo(() => (doc ? treeIndexOf(doc) : null), [doc]);
  const serial = useMemo(() => (doc ? serialNosOf(doc) : null), [doc]);
  const task = ix?.byId.get(idKey(taskId));
  const deps = task?.dependencies;
  // Candidate list: per document / task (not per keystroke).
  const candidates = useMemo(() => {
    if (!doc || !ix || !task) return [];
    const excluded = new Set(
      [taskId, ...getAncestors(ix, taskId), ...getDescendants(ix, taskId), ...(deps ?? []).map((d) => d.predecessorId)].map(idKey),
    );
    return derivedOf(doc).order.filter((o) => !excluded.has(idKey(o)));
  }, [doc, ix, task, taskId, deps]);
  if (!doc || !ix || !serial || !task) return null;
  const rowNo = (id: string) => serial.get(idKey(id)) ?? 0;
  const nameOf = (id: string) => ix.byId.get(idKey(id))?.name ?? "";
  const depList = deps ?? [];
  const selected = candidates.some((c) => idKey(c) === idKey(pick)) ? pick : "";
  const lagNum = Number(lag);
  const lagValid = lag.trim() !== "" && Number.isInteger(lagNum);

  const add = () => {
    if (selected === "" || !lagValid) return;
    const res = runCommand({
      type: "addDependency",
      succId: taskId,
      predId: selected,
      ...(lagNum !== 0 ? { lag: lagNum } : {}),
    });
    if (res.ok) {
      setPick("");
      setLag("0");
    }
  };

  return (
    <fieldset className="field predecessors">
      <legend>{t("panel.predecessors")}</legend>
      {depList.length === 0 && <small className="note">{t("panel.noPredecessors")}</small>}
      <ul className="pred-list">
        {depList.map((d) => (
          <li key={d.predecessorId}>
            <span className="pred-label">
              {t("panel.predecessorOption", { no: rowNo(d.predecessorId), name: nameOf(d.predecessorId) })}
            </span>
            <span className="pred-lag">
              <CommitInput
                type="number"
                value={String(d.lag ?? 0)}
                ariaLabel={t("panel.lag")}
                commit={(v) => {
                  const n = Number(v);
                  if (v.trim() === "" || !Number.isInteger(n)) return false;
                  return runCommand({ type: "setDependencyLag", succId: taskId, predId: d.predecessorId, lag: n }).ok;
                }}
              />
            </span>
            <button
              type="button"
              className="icon-btn"
              title={t("panel.remove")}
              aria-label={t("panel.remove")}
              onClick={() => runCommand({ type: "removeDependency", succId: taskId, predId: d.predecessorId })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="pred-add">
        <select value={selected} data-testid="pred-select" onChange={(e) => setPick(e.target.value)}>
          <option value="">{t("panel.selectTask")}</option>
          {candidates.map((c) => (
            <option key={c} value={c}>
              {t("panel.predecessorOption", { no: rowNo(c), name: nameOf(c) })}
            </option>
          ))}
        </select>
        <input
          type="number"
          step={1}
          value={lag}
          aria-label={t("panel.lag")}
          title={t("panel.lag")}
          className={lagValid ? undefined : "invalid"}
          onChange={(e) => setLag(e.target.value)}
        />
        <button type="button" disabled={selected === "" || !lagValid} data-testid="pred-add" onClick={add}>
          {t("panel.addPredecessor")}
        </button>
      </div>
    </fieldset>
  );
}
