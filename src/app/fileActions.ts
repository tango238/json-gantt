import type { DialogIssue } from "../components/dialogs/SchemaErrorDialog";
import { isDragActive } from "../components/chart/useDrag";
import { showToast } from "../components/uiStore";
import { isEditableTarget } from "../components/useKeyboard";
import { createEmptyDocument, loadDocument as normalizeDocument, type LoadIssue } from "../engine";
import { exportPdf } from "../export/exportPdf";
import { t, type Params } from "../i18n";
import type { GanttDocument } from "../model/types";
import { useAppStore } from "../store/appStore";
import { isDirty } from "../store/selectors";
import * as api from "../tauri/api";
import { isTauri } from "../tauri/isTauri";
import { errorText, toAppError, type AppError, type FileChangedPayload, type RustIssue } from "../tauri/types";
import { initialFileUi, useFileUi } from "./fileUiStore";

const app = () => useAppStore.getState();

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const isJson = (p: string) => /\.json$/i.test(p);

function desktopOnly(): boolean {
  if (isTauri()) return false;
  showToast("info", t("toast.desktopOnly"));
  return true;
}

/** Rust sends arbitrary JSON params; the UI only formats strings / numbers. */
function textParams(p: Record<string, unknown> | undefined): Params | undefined {
  if (!p) return undefined;
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = typeof v === "string" || typeof v === "number" ? v : JSON.stringify(v);
  }
  return out;
}
const fromRust = (i: RustIssue): LoadIssue => {
  const params = textParams(i.params);
  return { code: i.code, path: i.path, ...(params ? { params } : {}) };
};
export const toDialogIssue = (i: LoadIssue | RustIssue): DialogIssue => ({
  code: i.code,
  path: i.path,
  params: textParams(i.params),
  message: "message" in i ? i.message : undefined,
});

const modalOpen = (): boolean => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

/** Issues for the error dialog (IO and other failures become a single IO_ERROR line). */
export function dialogIssues(e: AppError): DialogIssue[] {
  switch (e.kind) {
    case "SCHEMA_INVALID":
      return e.errors.map(toDialogIssue);
    case "PARSE_ERROR":
      return [{ code: "PARSE_ERROR", path: "", params: { line: e.line, column: e.column, message: e.message }, message: e.message }];
    case "UNSUPPORTED_VERSION":
      return [{ code: "UNSUPPORTED_VERSION", path: "/version", params: { found: e.found, supported: e.supported } }];
    default:
      return [{ code: "IO_ERROR", path: "", params: { message: errorText(e) }, message: errorText(e) }];
  }
}

export async function refreshRecent(): Promise<void> {
  try {
    useFileUi.setState({ recentFiles: await api.getRecentFiles() });
  } catch {
    /* the list is a convenience */
  }
}

/** Registers the file as current: recent list + watcher (watch must be re-armed after every open/save). */
async function registerFile(path: string): Promise<void> {
  try {
    await api.addRecentFile(path);
  } catch {
    /* ignore */
  }
  try {
    await api.watchFile(path);
  } catch (e) {
    showToast("error", errorText(toAppError(e)));
  }
  await refreshRecent();
}

async function unwatchQuietly(): Promise<void> {
  try {
    await api.unwatchFile();
  } catch {
    /* nothing watched */
  }
}

/** Reads `path` and replaces the document of this window. Returns true on success. */
async function loadFromPath(path: string): Promise<boolean> {
  let res;
  try {
    res = await api.openFile(path);
  } catch (e) {
    useFileUi.setState({ schemaError: { filePath: path, issues: dialogIssues(toAppError(e)) } });
    void refreshRecent(); // the file may have been moved or deleted
    return false;
  }
  const r = normalizeDocument(res.document as GanttDocument);
  if (!r.ok) {
    // Rust already registered the path for this window; drop it when there is no document to go with it.
    if (app().doc === null) await unwatchQuietly();
    useFileUi.setState({ schemaError: { filePath: path, issues: r.errors.map(toDialogIssue) } });
    void refreshRecent();
    return false;
  }
  app().loadDocument(path, r.doc, [...res.warnings.map(fromRust), ...r.warnings]);
  useFileUi.setState({ externalChange: null, warningsDismissed: false, warningsDetail: false });
  await registerFile(path);
  return true;
}

/** Open `path` following 03 section 14: in place when the window is empty, otherwise new window / focus. */
export async function openPath(path: string): Promise<void> {
  if (desktopOnly()) return;
  try {
    if (await api.focusWindowWithFile(path)) return;
    if (app().doc !== null) {
      await api.newWindow(path);
      return;
    }
  } catch (e) {
    showToast("error", t("toast.openFailed", { message: errorText(toAppError(e)) }));
    return;
  }
  await loadFromPath(path);
}

export async function openFileDialog(): Promise<void> {
  if (desktopOnly()) return;
  let path: string | null;
  try {
    path = await api.openDialog();
  } catch (e) {
    showToast("error", t("toast.openFailed", { message: errorText(toAppError(e)) }));
    return;
  }
  if (path) await openPath(path);
}

export const openRecent = (path: string): Promise<void> => openPath(path);

export async function newDocument(): Promise<void> {
  if (app().doc !== null) {
    if (desktopOnly()) return;
    try {
      await api.newWindow(null, true);
    } catch (e) {
      showToast("error", errorText(toAppError(e)));
    }
    return;
  }
  if (isTauri()) await unwatchQuietly();
  app().loadDocument(null, createEmptyDocument({ projectName: t("project.defaultName") }), []);
  useFileUi.setState({ externalChange: null, warningsDismissed: false });
}

async function writeTo(path: string): Promise<boolean> {
  const doc = app().doc;
  if (!doc) return false;
  // Captured before the (async) write: edits made while saving must stay dirty.
  const top = app().undoStack[app().undoStack.length - 1]?.id ?? null;
  const view = doc.view;
  try {
    await api.saveFile(path, doc);
  } catch (e) {
    const err = toAppError(e);
    const issues = dialogIssues(err);
    if (issues) useFileUi.setState({ schemaError: { title: t("dialog.saveErrorTitle"), filePath: path, issues } });
    else showToast("error", t("toast.saveFailed", { message: errorText(err) }));
    return false;
  }
  app().markSaved(path, top, view);
  showToast("info", t("toast.saved"));
  await registerFile(path);
  return true;
}

export async function saveFileAs(): Promise<boolean> {
  if (desktopOnly()) return false;
  const doc = app().doc;
  if (!doc) return false;
  let path: string | null;
  try {
    path = await api.saveDialog(`${doc.project.name}.json`);
  } catch (e) {
    showToast("error", t("toast.saveFailed", { message: errorText(toAppError(e)) }));
    return false;
  }
  if (!path) return false;
  return writeTo(isJson(path) ? path : `${path}.json`);
}

export async function saveFile(): Promise<boolean> {
  if (desktopOnly()) return false;
  const s = app();
  if (!s.doc) return false;
  return s.filePath ? writeTo(s.filePath) : saveFileAs();
}

/** Re-reads the current file; replaces the document and clears Undo history. */
export async function reloadFromDisk(): Promise<void> {
  const path = app().filePath;
  useFileUi.setState({ externalChange: null });
  if (!path || desktopOnly()) return;
  await loadFromPath(path);
}

export async function exportPdfAction(): Promise<void> {
  if (desktopOnly() || !app().doc) return;
  try {
    const path = await exportPdf();
    if (path) showToast("info", t("toast.pdfSaved", { path }));
  } catch (e) {
    showToast("error", t("toast.pdfFailed", { message: errorText(toAppError(e)) }));
  }
}

/** `file-changed-externally` (04 section 6). */
export function handleExternalChange(ev: FileChangedPayload): void {
  const s = app();
  if (s.doc === null || s.filePath === null || ev.path !== s.filePath) return;
  if (ev.kind === "removed") useFileUi.setState({ externalChange: "removed" });
  else useFileUi.setState({ externalChange: isDirty(s) ? "changedDirty" : "changed" });
}

export const dismissExternalChange = (): void => useFileUi.setState({ externalChange: null });
export async function externalOverwrite(): Promise<void> {
  dismissExternalChange();
  await saveFile();
}
export async function externalSaveAs(): Promise<void> {
  dismissExternalChange();
  await saveFileAs();
}

/** Window close request: with unsaved changes, veto and ask. */
export function handleCloseRequested(ev: { preventDefault(): void }): void {
  if (closeBusy) {
    ev.preventDefault();
    return;
  }
  if (!isDirty(app())) return;
  ev.preventDefault();
  useFileUi.setState({ unsavedClose: true });
}
let closeBusy = false;
export async function closeSaving(): Promise<void> {
  if (closeBusy) return;
  closeBusy = true;
  // Hide the confirmation while saving so an error dialog never stacks on top of it.
  useFileUi.setState({ unsavedClose: false });
  try {
    if (!(await saveFile())) {
      // Failed or Save As cancelled: back to the confirmation, unless an error dialog took over.
      if (useFileUi.getState().schemaError === null) useFileUi.setState({ unsavedClose: true });
      return;
    }
    await api.destroyWindow();
  } finally {
    closeBusy = false;
  }
}
export async function closeDiscarding(): Promise<void> {
  useFileUi.setState({ unsavedClose: false });
  await api.destroyWindow();
}
export const cancelClose = (): void => useFileUi.setState({ unsavedClose: false });

/** `menu-action` from the native menu. */
export function handleMenuAction(action: string): void {
  if (isDragActive() || modalOpen()) return;
  switch (action) {
    case "new":
      void newDocument();
      return;
    case "open":
      void openFileDialog();
      return;
    case "save":
      void saveFile();
      return;
    case "saveAs":
      void saveFileAs();
      return;
    case "exportPdf":
      void exportPdfAction();
      return;
    case "undo":
    case "redo": {
      const el = document.activeElement;
      if (isEditableTarget(el)) {
        document.execCommand(action);
      } else if (action === "undo") app().undo();
      else app().redo();
    }
  }
}

/** Drop of files: first .json opens. */
export function handleDrop(paths: string[]): void {
  setDragOver(false);
  if (modalOpen()) return;
  const p = paths.find(isJson);
  if (p) void openPath(p);
}

function setDragOver(v: boolean): void {
  if (useFileUi.getState().dragOver !== v) useFileUi.setState({ dragOver: v });
}

/** Non-drop drag events: the frame shows only when the dragged files include a .json. */
export function handleDragEvent(type: "enter" | "over" | "leave", paths: string[]): void {
  if (type === "leave") setDragOver(false);
  else if (type === "enter") setDragOver(!modalOpen() && paths.some(isJson));
  // "over" carries no paths: keep the state decided on enter.
}

/** Startup: `?new=1` (opened by `new_window(null, true)`) starts with an empty new document. Returns true if handled. */
export function startupNewDocument(search: string = window.location.search): boolean {
  if (new URLSearchParams(search).get("new") !== "1") return false;
  void newDocument();
  return true;
}

export const windowTitle = (filePath: string | null, hasDoc: boolean, dirty: boolean): string =>
  hasDoc
    ? `${dirty ? "● " : ""}${filePath ? baseName(filePath) : t("app.untitled")} — ${t("app.name")}`
    : t("app.name");

export function resetFileUi(): void {
  useFileUi.setState({ ...initialFileUi });
}
