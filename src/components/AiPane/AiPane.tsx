import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { dismissError, reset, setClaudePath } from "../../ai/aiActions";
import { DEFAULT_PANE_HEIGHT, useAiStore } from "../../ai/aiStore";
import { t } from "../../i18n";
import { isTauri } from "../../tauri/isTauri";
import { errorText, toAppError } from "../../tauri/types";
import { showToast } from "../uiStore";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { clampPaneHeight, MIN_PANE_HEIGHT } from "./paneSize";

const KEY_STEP = 16;

async function locateClaude(): Promise<void> {
  try {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") await setClaudePath(picked);
  } catch (e) {
    showToast("error", errorText(toAppError(e)));
  }
}

export function AiPane() {
  const messages = useAiStore((s) => s.messages);
  const status = useAiStore((s) => s.status);
  const error = useAiStore((s) => s.error);
  const paneHeight = useAiStore((s) => s.paneHeight);
  const collapsed = useAiStore((s) => s.collapsed);
  const setPaneHeight = useAiStore((s) => s.setPaneHeight);
  const setCollapsed = useAiStore((s) => s.setCollapsed);
  const drag = useRef<{ y: number; h: number } | null>(null);

  // Re-clamp when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const h = useAiStore.getState().paneHeight;
      const c = clampPaneHeight(h, window.innerHeight);
      if (c !== h) setPaneHeight(c);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setPaneHeight]);

  // Errors other than "claude not found" have no banner; surface them as a toast.
  useEffect(() => {
    if (error && error.kind !== "AI_NOT_FOUND") {
      showToast("error", errorText(error));
      dismissError();
    }
  }, [error]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: paneHeight };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setPaneHeight(clampPaneHeight(drag.current.h - (e.clientY - drag.current.y), window.innerHeight));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    setPaneHeight(clampPaneHeight(paneHeight + dir * KEY_STEP, window.innerHeight));
  };

  const statusText = status === "running" ? t("ai.running") : status === "stopping" ? t("ai.stopping") : null;

  return (
    <section
      className="ai-pane"
      style={collapsed ? undefined : { height: paneHeight }}
      data-collapsed={collapsed || undefined}
      aria-label={t("ai.title")}
      aria-busy={status !== "idle"}
    >
      {!collapsed && (
        <div
          className="ai-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={paneHeight}
          aria-valuemin={MIN_PANE_HEIGHT}
          aria-label={t("ai.resize")}
          tabIndex={0}
          title={t("ai.resize")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
          onKeyDown={onResizeKey}
          onDoubleClick={() => setPaneHeight(clampPaneHeight(DEFAULT_PANE_HEIGHT, window.innerHeight))}
        />
      )}
      <div className="ai-header" onDoubleClick={() => setCollapsed(!collapsed)}>
        <button
          type="button"
          className="ai-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("ai.expand") : t("ai.collapse")}
          title={collapsed ? t("ai.expand") : t("ai.collapse")}
          onClick={() => setCollapsed(!collapsed)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="ai-title">{t("ai.title")}</span>
        <span className="ai-status" aria-live="polite">
          {statusText && (
            <>
              <span className="ai-spinner" aria-hidden="true" />
              {statusText}
            </>
          )}
        </span>
        <span className="ai-spacer" />
        <button
          type="button"
          title={t("ai.newSession")}
          disabled={!isTauri()}
          onClick={() => reset()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {t("ai.newSession")}
        </button>
      </div>
      {/* Hidden (not unmounted) when collapsed so the draft and scroll position survive. */}
      <div className="ai-body" hidden={collapsed}>
          {error?.kind === "AI_NOT_FOUND" && (
            <div className="ai-warning" role="alert">
              <span>{t("ai.notFound")}</span>
              <button type="button" title={t("ai.locate")} onClick={() => void locateClaude()}>
                {t("ai.locate")}
              </button>
              <button type="button" onClick={dismissError} aria-label={t("dialog.close")} title={t("dialog.close")}>
                ×
              </button>
            </div>
          )}
          {!isTauri() ? <div className="ai-desktop-only">{t("ai.desktopOnly")}</div> : null}
          <MessageList messages={messages} />
          <Composer />
      </div>
    </section>
  );
}
