import { t } from "../../i18n";
import { Modal } from "./Modal";

export type ExternalChangeKind = "changed" | "changedDirty" | "removed";

/** Handlers required per kind, so a missing wiring is a type error. */
export type ExternalChangeDialogProps =
  | { kind: "changed"; onReload: () => void; onDismiss: () => void }
  | { kind: "changedDirty"; onReload: () => void; onOverwrite: () => void; onDismiss: () => void }
  | { kind: "removed"; onSaveAs: () => void; onDismiss: () => void };

/** Notice for an externally modified / removed file (03 section 11.2). Display only. */
export function ExternalChangeDialog(props: ExternalChangeDialogProps) {
  const { onDismiss } = props;
  const message =
    props.kind === "changed"
      ? t("dialog.externalChanged")
      : props.kind === "changedDirty"
        ? t("dialog.externalChangedDirty")
        : t("dialog.externalRemoved");
  return (
    <Modal
      title={t("dialog.externalChangedTitle")}
      closeOnBackdrop={false}
      onCancel={onDismiss}
      actions={
        props.kind === "changed" ? (
          <>
            <button type="button" onClick={onDismiss}>
              {t("dialog.ignore")}
            </button>
            <button type="button" className="primary" data-autofocus onClick={props.onReload}>
              {t("dialog.reload")}
            </button>
          </>
        ) : props.kind === "changedDirty" ? (
          <>
            <button type="button" onClick={onDismiss} data-autofocus>
              {t("dialog.later")}
            </button>
            <button type="button" onClick={props.onOverwrite}>
              {t("dialog.overwrite")}
            </button>
            <button type="button" className="danger" onClick={props.onReload}>
              {t("dialog.reloadDiscard")}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onDismiss}>
              {t("dialog.close")}
            </button>
            <button type="button" className="primary" data-autofocus onClick={props.onSaveAs}>
              {t("dialog.saveAs")}
            </button>
          </>
        )
      }
    >
      <p className="modal-message">{message}</p>
    </Modal>
  );
}
