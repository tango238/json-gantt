import type { ReactNode } from "react";
import { t } from "../i18n";
import { idKey } from "../model/id";
import { useAppStore } from "../store/appStore";
import { canRedo, canUndo } from "../store/selectors";
import { selectionCaps, runCommand, deleteSelection } from "./actions";
import {
  IconAdd,
  IconDelete,
  IconDuplicate,
  IconIndent,
  IconMoveDown,
  IconMoveUp,
  IconNew,
  IconOpen,
  IconOutdent,
  IconPdf,
  IconRedo,
  IconSave,
  IconSidePanel,
  IconSwap,
  IconUndo,
} from "./icons";
import { detectPlatform, formatShortcut } from "./keymap";
import { ZoomSwitch } from "./ZoomSwitch";

interface Props {
  /** File actions are wired by WP10; a button without a handler is disabled. */
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  /** PDF export is implemented by WP9 / WP10. */
  onExportPdf?: () => void;
}

interface BtnProps {
  id: string;
  shortcut?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

const platform = detectPlatform();

function Btn({ id, shortcut, disabled, pressed, onClick, children }: BtnProps) {
  const label = t(`toolbar.${id}`);
  const title = shortcut ? `${label} (${formatShortcut(platform, shortcut)})` : label;
  return (
    <button
      type="button"
      className={`tb-btn${pressed ? " active" : ""}`}
      data-testid={`tb-${id}`}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled || !onClick}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="tb-sep" role="separator" />;

/** Toolbar (03 section 8.1). */
export function Toolbar({ onNew, onOpen, onSave, onExportPdf }: Props) {
  const doc = useAppStore((s) => s.doc);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectedDependency = useAppStore((s) => s.selectedDependency);
  const undoOk = useAppStore(canUndo);
  const redoOk = useAppStore(canRedo);
  const valueColumn = useAppStore((s) => s.valueColumn);
  const sidePanelOpen = useAppStore((s) => s.sidePanelOpen);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const setValueColumn = useAppStore((s) => s.setValueColumn);
  const setSidePanelOpen = useAppStore((s) => s.setSidePanelOpen);

  const hasDoc = doc !== null;
  const caps = selectionCaps(doc, selectedId);
  const withSel = (type: "duplicateTask" | "indent" | "outdent" | "moveUp" | "moveDown") => () => {
    if (selectedId !== null) runCommand({ type, id: selectedId });
  };
  const currentColor = (selectedId !== null && doc?.tasks.find((x) => idKey(x.id) === idKey(selectedId))?.colorLabelId) || "";

  return (
    <div
      className="toolbar"
      role="toolbar"
      // Keep focus where it is (so Enter / Delete keep working on the chart); selects need focus.
      onMouseDown={(e) => {
        if (!(e.target instanceof Element && e.target.closest("select"))) {
          // preventDefault keeps focus (so no blur happens): commit a pending inline edit first.
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.classList.contains("inline-editor")) active.blur();
          e.preventDefault();
        }
      }}
    >
      <Btn id="new" onClick={onNew}>
        <IconNew />
      </Btn>
      <Btn id="open" onClick={onOpen}>
        <IconOpen />
      </Btn>
      <Btn id="save" shortcut="Mod+S" disabled={!hasDoc} onClick={onSave}>
        <IconSave />
      </Btn>
      <Sep />
      <Btn id="undo" shortcut="Mod+Z" disabled={!undoOk} onClick={undo}>
        <IconUndo />
      </Btn>
      <Btn id="redo" shortcut="Mod+Shift+Z" disabled={!redoOk} onClick={redo}>
        <IconRedo />
      </Btn>
      <Sep />
      <Btn id="addTask" shortcut="Enter" disabled={!hasDoc} onClick={() => runCommand({ type: "addTask", afterId: selectedId })}>
        <IconAdd />
      </Btn>
      <Btn id="deleteTask" shortcut="Delete" disabled={!caps.hasSelection && !selectedDependency} onClick={deleteSelection}>
        <IconDelete />
      </Btn>
      <Btn id="duplicate" shortcut="Mod+D" disabled={!caps.hasSelection} onClick={withSel("duplicateTask")}>
        <IconDuplicate />
      </Btn>
      <Sep />
      <Btn id="indent" shortcut="Tab" disabled={!caps.canIndent} onClick={withSel("indent")}>
        <IconIndent />
      </Btn>
      <Btn id="outdent" shortcut="Shift+Tab" disabled={!caps.canOutdent} onClick={withSel("outdent")}>
        <IconOutdent />
      </Btn>
      <Btn id="moveUp" shortcut="Alt+↑" disabled={!caps.canMoveUp} onClick={withSel("moveUp")}>
        <IconMoveUp />
      </Btn>
      <Btn id="moveDown" shortcut="Alt+↓" disabled={!caps.canMoveDown} onClick={withSel("moveDown")}>
        <IconMoveDown />
      </Btn>
      <Sep />
      <select
        className="tb-select"
        data-testid="tb-colorLabel"
        title={t("toolbar.colorLabel")}
        aria-label={t("toolbar.colorLabel")}
        disabled={!caps.hasSelection}
        value={currentColor}
        onChange={(e) => {
          if (selectedId !== null) {
            runCommand({ type: "setColorLabel", id: selectedId, colorLabelId: e.target.value === "" ? null : e.target.value });
          }
          e.target.blur();
        }}
      >
        <option value="">{t("toolbar.colorLabelNone")}</option>
        {(doc?.colorLabels ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Btn
        id="toggleValueColumn"
        pressed={valueColumn === "hours"}
        onClick={() => setValueColumn(valueColumn === "duration" ? "hours" : "duration")}
      >
        <IconSwap />
      </Btn>
      <Sep />
      {hasDoc && <ZoomSwitch />}
      <span className="tb-spacer" />
      <Btn id="exportPdf" shortcut="Mod+Shift+E" disabled={!hasDoc} onClick={onExportPdf}>
        <IconPdf />
      </Btn>
      <Btn id="toggleSidePanel" pressed={sidePanelOpen} onClick={() => setSidePanelOpen(!sidePanelOpen)}>
        <IconSidePanel />
      </Btn>
    </div>
  );
}
