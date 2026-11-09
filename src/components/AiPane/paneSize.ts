export const MIN_PANE_HEIGHT = 120;
const TOOLBAR_HEIGHT = 40;
const STATUS_BAR_HEIGHT = 24;
export const MIN_CHART_HEIGHT = 200;

/** Largest pane height that still leaves the chart MIN_CHART_HEIGHT (06 section 4.8). */
export const maxPaneHeight = (windowHeight: number): number =>
  windowHeight - TOOLBAR_HEIGHT - STATUS_BAR_HEIGHT - MIN_CHART_HEIGHT;

/** Clamp to [120, window - 264]; the minimum wins when the window is too small. */
export function clampPaneHeight(h: number, windowHeight: number): number {
  return Math.round(Math.max(MIN_PANE_HEIGHT, Math.min(h, maxPaneHeight(windowHeight))));
}
