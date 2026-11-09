// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../../../../schema/examples/sample.json";
import { loadDocument } from "../../../engine";
import type { GanttDocument } from "../../../model/types";
import { setCommandContextOverride, useAppStore } from "../../../store/appStore";
import { ColorInput } from "../ColorInput";
import { CommitInput } from "../fields";
import { ProgressField } from "../ProgressField";

afterEach(cleanup);

function Harness({ commit }: { commit: (v: string) => boolean | void }) {
  const [value, setValue] = useState("abc");
  return (
    <>
      <CommitInput
        value={value}
        testId="in"
        commit={(v) => {
          commit(v);
          setValue(v);
        }}
      />
    </>
  );
}
const input = () => screen.getByTestId("in") as HTMLInputElement;

describe("CommitInput", () => {
  it("commits on Enter", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(commit).toHaveBeenCalledExactlyOnceWith("xyz");
  });
  it("commits on blur", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.blur(input());
    expect(commit).toHaveBeenCalledExactlyOnceWith("xyz");
  });
  it("Escape reverts and does not commit", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    input().focus();
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(commit).not.toHaveBeenCalled();
    expect(input().value).toBe("abc");
  });
  it("commits a pending draft on unmount", () => {
    const commit = vi.fn();
    const { unmount } = render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    unmount();
    expect(commit).toHaveBeenCalledExactlyOnceWith("xyz");
  });
  it("does not commit on unmount right after Escape", () => {
    const commit = vi.fn();
    const { unmount } = render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    unmount();
    expect(commit).not.toHaveBeenCalled();
  });
  it("does not double-commit when blurred then unmounted", () => {
    const commit = vi.fn();
    const { unmount } = render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.blur(input());
    unmount();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

const st = () => useAppStore.getState();

describe("ProgressField", () => {
  beforeEach(() => {
    setCommandContextOverride({ today: "2023-05-22", newId: () => "N1", defaultTaskName: "task" });
    const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
    if (!r.ok) throw new Error("invalid sample");
    useAppStore.setState({ doc: null, undoStack: [], redoStack: [], preview: null });
    st().loadDocument("/tmp/sample.json", r.doc, r.warnings);
  });

  it("dispatches setProgress once on native change and one Undo reverts it", () => {
    const id = st().doc!.tasks.find((x) => !st().doc!.tasks.some((y) => y.parentId === x.id) && (x.progress ?? 0) !== 77)!.id;
    const before = st().doc;
    const depth = st().undoStack.length;
    render(<ProgressField taskId={id} progress={0} disabled={false} />);
    const el = screen.getByTestId("panel-progress") as HTMLInputElement;
    fireEvent.input(el, { target: { value: "77" } });
    expect(st().preview).not.toBeNull();
    expect(st().undoStack.length).toBe(depth);
    act(() => {
      fireEvent.change(el);
    });
    expect(st().preview).toBeNull();
    expect(st().undoStack.length).toBe(depth + 1);
    expect(st().doc!.tasks.find((x) => x.id === id)!.progress).toBe(77);
    st().undo();
    expect(st().undoStack.length).toBe(depth);
    expect(st().doc).toEqual(before);
  });
  it("clears the preview when unmounted mid-drag", () => {
    const id = st().doc!.tasks[3]!.id;
    const { unmount } = render(<ProgressField taskId={id} progress={0} disabled={false} />);
    fireEvent.input(screen.getByTestId("panel-progress"), { target: { value: "40" } });
    expect(st().preview).not.toBeNull();
    unmount();
    expect(st().preview).toBeNull();
  });
});

describe("ColorInput", () => {
  it("commits two consecutive changes", () => {
    const onCommit = vi.fn();
    function H() {
      const [v, setV] = useState("#4A90D9");
      return (
        <ColorInput
          value={v}
          label="color"
          onCommit={(c) => {
            onCommit(c);
            setV(c);
          }}
        />
      );
    }
    render(<H />);
    const el = screen.getByLabelText("color") as HTMLInputElement;
    fireEvent.input(el, { target: { value: "#ff0000" } });
    fireEvent.change(el);
    fireEvent.input(el, { target: { value: "#00ff00" } });
    fireEvent.change(el);
    expect(onCommit.mock.calls).toEqual([["#FF0000"], ["#00FF00"]]);
  });
});
