// Engine error codes (docs/design/02-engine.md section 6).
export type EngineErrorCode =
  | "TASK_NOT_FOUND"
  | "PARENT_NOT_EDITABLE"
  | "START_AFTER_END"
  | "INVALID_VALUE"
  | "NO_PREVIOUS_SIBLING"
  | "NO_NEXT_SIBLING"
  | "NOT_INDENTED"
  | "DEPENDENCY_CONFLICT"
  | "DEPENDENCY_SELF"
  | "DEPENDENCY_DUPLICATE"
  | "DEPENDENCY_ANCESTOR"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_NOT_FOUND"
  | "SCHEDULING_DIVERGED"
  | "CALENDAR_NO_WORKING_DAY";

export type ErrorParams = Record<string, string | number>;

/** A command precondition failed. Thrown inside a recipe; converted to CommandErr by executeCommand. */
export class CommandRejected extends Error {
  readonly code: EngineErrorCode;
  readonly params?: ErrorParams;
  constructor(code: EngineErrorCode, params?: ErrorParams) {
    super(code);
    this.name = "CommandRejected";
    this.code = code;
    this.params = params;
  }
}

export class CalendarError extends Error {
  readonly code: "CALENDAR_NO_WORKING_DAY" = "CALENDAR_NO_WORKING_DAY";
  constructor() {
    super("CALENDAR_NO_WORKING_DAY");
    this.name = "CalendarError";
  }
}

export class SchedulingError extends Error {
  readonly code: "SCHEDULING_DIVERGED" = "SCHEDULING_DIVERGED";
  constructor() {
    super("SCHEDULING_DIVERGED");
    this.name = "SchedulingError";
  }
}
