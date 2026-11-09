import { t } from "../i18n";
import { todayIso } from "../model/date";
import { displayDoc } from "../store/selectors";
import { exportPdf as exportPdfCommand } from "../tauri/api";
import { useAppStore } from "../store/appStore";
import { GRID_WIDTH } from "../components/chart/constants";
import { composeSvg } from "./composeSvg";

export interface PdfOptions {
  pageSize: "A3";
  orientation: "landscape";
  frozenWidth: number;
  defaultFileName: string;
  title: string;
}

function defaultFileName(filePath: string | null): string {
  const base = filePath?.split(/[\\/]/).pop()?.replace(/\.json$/i, "");
  return `${base || t("app.untitled")}.pdf`;
}

/** Exports the current screen state to PDF. Resolves to the saved path, or null when cancelled. */
export async function exportPdf(): Promise<string | null> {
  const s = useAppStore.getState();
  const doc = displayDoc(s);
  if (!doc) return null;
  const { svg } = composeSvg({ doc, valueColumn: s.valueColumn, today: todayIso() });
  const options: PdfOptions = {
    pageSize: "A3",
    orientation: "landscape",
    frozenWidth: GRID_WIDTH,
    defaultFileName: defaultFileName(s.filePath),
    title: doc.project.name,
  };
  return exportPdfCommand(svg, options);
}
