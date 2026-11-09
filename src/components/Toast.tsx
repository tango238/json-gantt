import { dismissToast, useUiStore } from "./uiStore";

/** Bottom-right toast stack (03 section 11.6). */
export function Toast() {
  const toasts = useUiStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((x) => (
        <div
          key={x.id}
          className={`toast toast-${x.kind}`}
          role={x.kind === "error" ? "alert" : "status"}
          onClick={() => dismissToast(x.id)}>
          {x.message}
        </div>
      ))}
    </div>
  );
}
