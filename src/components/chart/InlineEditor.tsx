import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatDuration, getDerived, parseDuration } from "../../engine";
import { idKey } from "../../model/id";
import { useAppStore } from "../../store/appStore";
import { calendarOf, derivedOf, displayDoc } from "../../store/selectors";
import { runCommand } from "../actions";
import { COL_NAME, COL_NO, COL_VALUE, ROW_HEIGHT } from "./constants";
import type { RowLayout } from "./layout";

const HOURS_RE = /^\d+(\.\d+)?$/;

/**
 * Single `<input>` overlay on the grid body for name / duration / hours editing (03 section 7).
 * Rendered inside the (sticky, positioned) grid-body wrapper.
 */
export function InlineEditor({ rows }: { rows: readonly RowLayout[] }) {
  const editing = useAppStore((s) => s.editing);
  const doc = useAppStore(displayDoc);
  if (!editing || !doc) return null;
  const row = rows.find((r) => idKey(r.taskId) === idKey(editing.taskId));
  if (!row) return null;
  if (editing.field !== "name" && row.isParent) return null;

  const wc = calendarOf(doc);
  const dt = getDerived(derivedOf(doc), row.taskId);
  let initial = "";
  if (editing.field === "name") initial = row.name;
  else if (editing.field === "duration") initial = dt ? formatDuration(dt.durationDays, wc) : "";
  else initial = dt?.hours !== undefined ? String(dt.hours) : "";

  return (
    <EditorInput
      key={`${editing.taskId}|${editing.field}`}
      taskId={row.taskId}
      field={editing.field}
      initial={initial}
      left={editing.field === "name" ? COL_NO : COL_NO + COL_NAME}
      width={editing.field === "name" ? COL_NAME : COL_VALUE}
      top={row.y + 1}
    />
  );
}

interface InputProps {
  taskId: string;
  field: "name" | "duration" | "hours";
  initial: string;
  left: number;
  width: number;
  top: number;
}

function EditorInput({ taskId, field, initial, left, width, top }: InputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const close = () => {
    done.current = true;
    useAppStore.getState().setEditing(null);
  };

  /** Apply the value. Returns false when the input is invalid (editing continues). */
  const apply = (): boolean => {
    const text = value.trim();
    if (field === "name") {
      if (text !== "" && text !== initial) runCommand({ type: "setName", id: taskId, name: text });
      return true;
    }
    if (field === "duration") {
      const doc = useAppStore.getState().doc;
      if (!doc) return true;
      const days = parseDuration(text, calendarOf(doc));
      if (days === null) return false;
      if (text !== initial) runCommand({ type: "setDuration", id: taskId, days });
      return true;
    }
    if (text === "") {
      if (initial !== "") runCommand({ type: "setHours", id: taskId, hours: null });
      return true;
    }
    if (!HOURS_RE.test(text)) return false;
    const n = Number(text);
    if (text !== initial) runCommand({ type: "setHours", id: taskId, hours: n });
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // keyCode 229: WKWebView reports the IME commit Enter as a plain keydown after compositionend.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (apply()) close();
      else setInvalid(true);
    } else if (e.key === "Tab" && field === "name") {
      e.preventDefault();
      e.stopPropagation();
      apply();
      close();
      runCommand({ type: e.shiftKey ? "outdent" : "indent", id: taskId });
    }
  };

  const onBlur = () => {
    if (done.current) return;
    apply(); // an invalid value is discarded on blur
    close();
  };

  return (
    <input
      ref={ref}
      className={`inline-editor${invalid ? " invalid" : ""}`}
      style={{ position: "absolute", left, top, width, height: ROW_HEIGHT - 2, boxSizing: "border-box" }}
      value={value}
      inputMode={field === "name" ? "text" : "decimal"}
      onChange={(e) => {
        setValue(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
