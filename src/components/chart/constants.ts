import type { Zoom } from "../../model/types";

export const ROW_HEIGHT = 26;
export const HEADER_ROW_HEIGHT = 24;
export const HEADER_HEIGHT = HEADER_ROW_HEIGHT * 2;

export const COL_NO = 40;
export const COL_NAME = 210;
export const COL_VALUE = 80;
export const GRID_WIDTH = COL_NO + COL_NAME + COL_VALUE;

export const INDENT_PX = 16;
export const TOGGLE_PX = 14;

export const DAY_WIDTH: Record<Zoom, number> = { day: 68, week: 20, month: 6 };

export const BAR_HEIGHT = 16;
export const BAR_OFFSET_Y = 5;
export const SUMMARY_HEIGHT = 6;
export const SUMMARY_OFFSET_Y = 7;
export const ARROW_GAP = 8;
export const EDGE_HIT_PX = 6;

export const TOOLBAR_HEIGHT = 40;
export const STATUSBAR_HEIGHT = 24;
export const SIDEPANEL_WIDTH = 300;
export const EXPORT_TITLE_HEIGHT = 40;

export const COLORS = {
  text: "#1F2937",
  textMuted: "#6B7280",
  textDim: "#9CA3AF",
  label: "#4B5563",
  border: "#E5E7EB",
  dayLine: "#F0F0F0",
  headerBg: "#F9FAFB",
  selectedRow: "#E3F0FF",
  hoverRow: "#F5F9FF",
  nonWorking: "#F3F4F6",
  today: "#EF4444",
  barDefault: "#4A90D9",
  summaryDefault: "#374151",
  selection: "#1D4ED8",
  arrow: "#6B7280",
  arrowViolated: "#DC2626",
  onDark: "#FFFFFF",
} as const;

export const FONT_FAMILY = '-apple-system, "Hiragino Sans", "Yu Gothic UI", "Segoe UI", sans-serif';
