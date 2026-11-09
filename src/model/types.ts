export type {
  GanttDocument,
  Task,
  Resource,
  ColorLabel,
  Dependency,
  Project,
  Calendar,
  ViewSettings,
} from "./schema";

/** Calendar date "YYYY-MM-DD" (no time, no timezone). */
export type IsoDate = string;
export type Zoom = "day" | "week" | "month";
