import { describe, expect, it } from "vitest";
import { clampPaneHeight } from "../AiPane/paneSize";

describe("clampPaneHeight (U1)", () => {
  it("clamps to the minimum", () => expect(clampPaneHeight(50, 1000)).toBe(120));
  it("keeps values in range", () => expect(clampPaneHeight(300, 1000)).toBe(300));
  it("clamps to window - 264", () => expect(clampPaneHeight(900, 1000)).toBe(736));
  it("prefers the minimum when the window is too small", () => expect(clampPaneHeight(240, 300)).toBe(120));
});
