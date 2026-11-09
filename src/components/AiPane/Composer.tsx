import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { send, stop } from "../../ai/aiActions";
import { useAiStore } from "../../ai/aiStore";
import { t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { isTauri } from "../../tauri/isTauri";
import { isDragActive } from "../chart/useDrag";

/** Right after [send] turns into [stop], ignore clicks so a double click cannot stop the turn. */
const STOP_GUARD_MS = 300;

export function Composer() {
  const [text, setText] = useState("");
  const [stopReady, setStopReady] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const status = useAiStore((s) => s.status);
  const hasDoc = useAppStore((s) => s.doc !== null);
  const busy = status !== "idle";

  useEffect(() => {
    if (!busy) {
      setStopReady(false);
      return;
    }
    const id = setTimeout(() => setStopReady(true), STOP_GUARD_MS);
    return () => clearTimeout(id);
  }, [busy]);

  const canSend = () => hasDoc && text.trim() !== "" && !busy && !isDragActive() && isTauri();

  const submit = () => {
    if (!canSend()) return;
    const value = text;
    setText("");
    if (ref.current) {
      ref.current.style.height = "";
      ref.current.focus();
    }
    void send(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (useAiStore.getState().status === "running") void stop();
      else ref.current?.blur();
    }
  };

  // The height cap lives in CSS (max-height, border-box); here we only fit the content.
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  };

  return (
    <div className="ai-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={t("ai.composerLabel")}
        placeholder={t("ai.placeholder")}
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <button
          key="stop"
          type="button"
          onClick={() => void stop()}
          disabled={status === "stopping" || !stopReady}
          title={t("ai.stop")}
        >
          {t("ai.stop")}
        </button>
      ) : (
        <button key="send" type="button" onClick={submit} disabled={!canSend()} title={t("ai.send")}>
          {t("ai.send")}
        </button>
      )}
    </div>
  );
}
