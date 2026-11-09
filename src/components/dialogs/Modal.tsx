import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  title?: string;
  /** Escape / backdrop click. */
  onCancel: () => void;
  children: ReactNode;
  actions: ReactNode;
  wide?: boolean;
  /** Id of an element inside `children` that labels the dialog (when there is no `title`). */
  labelledBy?: string;
  /** Close on a backdrop click (default true). Dialogs that must not lose a decision set false. */
  closeOnBackdrop?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open modals, last = frontmost. Only the frontmost handles Escape / Tab. */
const stack: symbol[] = [];

/**
 * Shared modal shell. `role="dialog" aria-modal` disables the global shortcuts. Focus is trapped
 * inside (Tab cycles), initial focus goes to `[autofocus]` / `[data-autofocus]` or the first
 * control, and focus returns to the previously focused element on close.
 */
export function Modal({ title, onCancel, children, actions, wide, labelledBy, closeOnBackdrop = true }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const me = Symbol("modal");
    stack.push(me);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const target =
        dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
      target.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelRef.current();
      } else if (e.key === "Tab") {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        const inside = active instanceof Node && dialogRef.current?.contains(active) === true;
        if (!inside || (e.shiftKey && active === first)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={closeOnBackdrop ? () => cancelRef.current() : undefined}>
      <div
        className={`modal${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : labelledBy}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
        )}
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
