import { create } from "zustand";
import type { RecentFile } from "../components/EmptyState";
import type { ExternalChangeKind } from "../components/dialogs/ExternalChangeDialog";
import type { DialogIssue } from "../components/dialogs/SchemaErrorDialog";

export interface SchemaErrorState {
  title?: string;
  filePath: string | null;
  issues: DialogIssue[];
}

interface FileUiState {
  schemaError: SchemaErrorState | null;
  externalChange: ExternalChangeKind | null;
  unsavedClose: boolean;
  warningsDetail: boolean;
  warningsDismissed: boolean;
  dragOver: boolean;
  recentFiles: RecentFile[];
}

export const initialFileUi: FileUiState = {
  schemaError: null,
  externalChange: null,
  unsavedClose: false,
  warningsDetail: false,
  warningsDismissed: false,
  dragOver: false,
  recentFiles: [],
};

/** Dialog visibility etc. for the file lifecycle (WP10). */
export const useFileUi = create<FileUiState>()(() => ({ ...initialFileUi }));
