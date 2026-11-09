import { t } from "../../i18n";
import { Modal } from "./Modal";

interface Props {
  name: string;
  onSave: () => void;
  onDontSave: () => void;
  onCancel: () => void;
}

/** Confirmation when closing with unsaved changes (03 section 11.3). Display only. */
export function UnsavedCloseDialog({ name, onSave, onDontSave, onCancel }: Props) {
  return (
    <Modal
      title={t("dialog.unsavedTitle")}
      closeOnBackdrop={false}
      onCancel={onCancel}
      actions={
        <>
          <button type="button" onClick={onCancel}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="danger" onClick={onDontSave}>
            {t("dialog.dontSave")}
          </button>
          <button type="button" className="primary" data-autofocus onClick={onSave}>
            {t("dialog.save")}
          </button>
        </>
      }
    >
      <p className="modal-message">{t("dialog.unsaved", { name })}</p>
    </Modal>
  );
}
