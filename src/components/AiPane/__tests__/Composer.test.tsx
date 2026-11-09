// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ send: vi.fn(), stop: vi.fn() }));
vi.mock("../../../ai/aiActions", () => ({ send: m.send, stop: m.stop }));
vi.mock("../../../tauri/isTauri", () => ({ isTauri: () => true }));

import { resetAiStore, useAiStore } from "../../../ai/aiStore";
import { useAppStore } from "../../../store/appStore";
import { Composer } from "../Composer";

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

beforeEach(() => {
  m.send.mockReset();
  m.stop.mockReset();
  resetAiStore();
  useAppStore.setState({ doc: {} as never });
});
afterEach(cleanup);

describe("Composer (U2)", () => {
  it("sends on Enter and clears", () => {
    render(<Composer />);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(m.send).toHaveBeenCalledWith("hello");
    expect(box().value).toBe("");
  });
  it("does not send on Shift+Enter", () => {
    render(<Composer />);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("does not send while composing (IME)", () => {
    render(<Composer />);
    fireEvent.change(box(), { target: { value: "\u3042" } });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("does not send an empty message", () => {
    render(<Composer />);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("Escape stops a running turn", () => {
    useAiStore.setState({ status: "running" });
    render(<Composer />);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(m.stop).toHaveBeenCalled();
  });
  it("Escape during IME composition does not stop the turn", () => {
    useAiStore.setState({ status: "running" });
    render(<Composer />);
    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    fireEvent.keyDown(box(), { key: "Escape", keyCode: 229 });
    expect(m.stop).not.toHaveBeenCalled();
  });
  it("a double click on [send] does not stop the turn it just started", () => {
    vi.useFakeTimers();
    try {
      render(<Composer />);
      fireEvent.change(box(), { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button"));
      expect(m.send).toHaveBeenCalledWith("hello");
      act(() => useAiStore.setState({ status: "running" }));
      fireEvent.click(screen.getByRole("button"));
      expect(m.stop).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      fireEvent.click(screen.getByRole("button"));
      expect(m.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not send while running", () => {
    useAiStore.setState({ status: "running" });
    render(<Composer />);
    fireEvent.change(box(), { target: { value: "next" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(m.send).not.toHaveBeenCalled();
  });
});
