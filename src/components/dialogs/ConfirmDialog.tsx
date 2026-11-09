import { useId } from "react";
import { t } from "../../i18n";
import { Modal } from "./Modal";
import { closeConfirm, useUiStore } from "../uiStore";

interface Props {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Generic confirm modal (03 section 11.4). Escape = cancel; initial focus is on the cancel button. */
export function ConfirmDialog({ message, confirmLabel, cancelLabel, onConfirm, onCancel }: Props) {
  const messageId = useId();
  return (
    <Modal
      onCancel={onCancel}
      labelledBy={messageId}
      actions={
        <>
          <button type="button" data-autofocus onClick={onCancel}>
            {cancelLabel ?? t("dialog.cancel")}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="modal-message" id={messageId}>
        {message}
      </p>
    </Modal>
  );
}

/** Renders the pending confirm request from the UI store. */
export function ConfirmHost() {
  const req = useUiStore((s) => s.confirm);
  if (!req) return null;
  return (
    <ConfirmDialog
      message={req.message}
      confirmLabel={req.confirmLabel}
      onCancel={closeConfirm}
      onConfirm={() => {
        closeConfirm();
        req.onConfirm();
      }}
    />
  );
}
