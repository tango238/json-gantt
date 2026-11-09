import { useEffect } from "react";
import {
  baseName,
  cancelClose,
  closeDiscarding,
  closeSaving,
  dismissExternalChange,
  exportPdfAction,
  externalOverwrite,
  externalSaveAs,
  handleCloseRequested,
  handleDragEvent,
  handleDrop,
  handleExternalChange,
  handleMenuAction,
  newDocument,
  openFileDialog,
  openPath,
  openRecent,
  refreshRecent,
  startupNewDocument,
  reloadFromDisk,
  saveFile,
  saveFileAs,
  windowTitle,
} from "./app/fileActions";
import { useFileUi } from "./app/fileUiStore";
import { initAiActions } from "./ai/aiActions";
import { AiPane } from "./components/AiPane/AiPane";
import { ChartView } from "./components/chart/ChartView";
import { ConfirmHost } from "./components/dialogs/ConfirmDialog";
import { ExternalChangeDialog } from "./components/dialogs/ExternalChangeDialog";
import { SchemaErrorDialog } from "./components/dialogs/SchemaErrorDialog";
import { UnsavedCloseDialog } from "./components/dialogs/UnsavedCloseDialog";
import { WarningsBanner } from "./components/dialogs/WarningsBanner";
import { EmptyState } from "./components/EmptyState";
import { SidePanel } from "./components/SidePanel/SidePanel";
import { StatusBar } from "./components/StatusBar";
import { Toast } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { useKeyboard } from "./components/useKeyboard";
import { t } from "./i18n";
import { useAppStore } from "./store/appStore";
import { isDirty } from "./store/selectors";
import * as api from "./tauri/api";
import * as events from "./tauri/events";
import { isTauri } from "./tauri/isTauri";
import "./styles/app.css";

// Layout (03 section 1):
//   Toolbar
//   WarningsBanner
//   .app-main: ChartView | <aside> (WP8: SidePanel)
//   <footer>  (WP8: StatusBar)
const onSave = () => void saveFile();
const onSaveAs = () => void saveFileAs();
const onExportPdf = () => void exportPdfAction();
const onNew = () => void newDocument();
const onOpen = () => void openFileDialog();
const keyHandlers = { onSave, onSaveAs, onExportPdf };

/** Subscriptions to Rust events, window close and drag & drop (Tauri only). */
function useTauriBindings(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const add = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unlisten.push(u))).catch(() => undefined);
    void (async () => {
      await Promise.all([
        add(events.onMenuAction((p) => handleMenuAction(p.action))),
        add(events.onOpenFileRequested((p) => void openPath(p.path))),
        add(events.onFileChangedExternally(handleExternalChange)),
        add(events.onCloseRequested(handleCloseRequested)),
        add(
          events.onDragDrop((p) => {
            if (p.type === "drop") handleDrop(p.paths);
            else handleDragEvent(p.type, p.paths);
          }),
        ),
      ]);
      if (cancelled) return; // StrictMode: the first effect run is torn down
      // Registers this window as ready (even a `?new=1` window, so later OS open
      // requests routed to it are delivered) and receives a path given at launch.
      try {
        const pending = await api.takePendingOpen();
        if (pending) {
          await openPath(pending);
          return;
        }
      } catch {
        /* nothing pending */
      }
      startupNewDocument();
    })();
    return () => {
      cancelled = true;
      unlisten.splice(0).forEach((u) => u());
    };
  }, []);
}

function App() {
  const sidePanelOpen = useAppStore((s) => s.sidePanelOpen);
  const hasDoc = useAppStore((s) => s.doc !== null);
  const filePath = useAppStore((s) => s.filePath);
  const dirty = useAppStore(isDirty);
  const loadWarnings = useAppStore((s) => s.loadWarnings);
  const ui = useFileUi();
  useKeyboard(keyHandlers);
  useTauriBindings();
  useEffect(() => initAiActions(), []);

  const title = windowTitle(filePath, hasDoc, dirty);
  useEffect(() => {
    document.title = title;
    if (isTauri()) void api.setWindowTitle(title).catch(() => undefined);
  }, [title]);

  // The recent list on the empty screen should be fresh when returning to it.
  useEffect(() => {
    if (!hasDoc && isTauri()) void refreshRecent();
  }, [hasDoc]);

  const docName = filePath ? baseName(filePath) : t("app.untitled");

  return (
    <div className="app">
      <Toolbar onNew={onNew} onOpen={onOpen} onSave={onSave} onExportPdf={onExportPdf} />
      {hasDoc && !ui.warningsDismissed && (
        <WarningsBanner
          count={loadWarnings.length}
          onDetails={() => useFileUi.setState({ warningsDetail: true })}
          onDismiss={() => useFileUi.setState({ warningsDismissed: true })}
        />
      )}
      <div className="app-main">
        {hasDoc ? (
          <ChartView />
        ) : (
          <EmptyState onNew={onNew} onOpen={onOpen} recentFiles={ui.recentFiles} onOpenRecent={(p) => void openRecent(p)} />
        )}
        <aside className="side-panel" hidden={!sidePanelOpen || !hasDoc}>
          <SidePanel />
        </aside>
        {ui.dragOver && <div className="drop-overlay" data-testid="drop-overlay" />}
      </div>
      {hasDoc && <AiPane />}
      <footer className="status-bar">
        <StatusBar />
      </footer>
      <Toast />
      <ConfirmHost />
      {ui.schemaError && (
        <SchemaErrorDialog
          title={ui.schemaError.title}
          filePath={ui.schemaError.filePath}
          issues={ui.schemaError.issues}
          onClose={() => useFileUi.setState({ schemaError: null })}
        />
      )}
      {ui.warningsDetail && (
        <SchemaErrorDialog
          title={t("dialog.warningsTitle")}
          filePath={filePath}
          issues={loadWarnings.map((w) => ({ code: w.code, path: w.path, params: w.params }))}
          onClose={() => useFileUi.setState({ warningsDetail: false })}
        />
      )}
      {ui.externalChange === "changed" && (
        <ExternalChangeDialog kind="changed" onReload={() => void reloadFromDisk()} onDismiss={dismissExternalChange} />
      )}
      {ui.externalChange === "changedDirty" && (
        <ExternalChangeDialog
          kind="changedDirty"
          onReload={() => void reloadFromDisk()}
          onOverwrite={() => void externalOverwrite()}
          onDismiss={dismissExternalChange}
        />
      )}
      {ui.externalChange === "removed" && (
        <ExternalChangeDialog kind="removed" onSaveAs={() => void externalSaveAs()} onDismiss={dismissExternalChange} />
      )}
      {ui.unsavedClose && (
        <UnsavedCloseDialog
          name={docName}
          onSave={() => void closeSaving()}
          onDontSave={() => void closeDiscarding()}
          onCancel={cancelClose}
        />
      )}
    </div>
  );
}

export default App;
