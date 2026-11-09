// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AiMessage } from "../../../ai/types";
import { MessageList } from "../MessageList";

afterEach(cleanup);

const assistant = (id: number): AiMessage => ({ id: `m${id}`, kind: "assistant", text: "a" });
const user = (id: number): AiMessage => ({ id: `m${id}`, kind: "user", text: "u" });

describe("MessageList follow", () => {
  it("scrolls to the bottom when the user sends, even after scrolling up", () => {
    const { container, rerender } = render(<MessageList messages={[assistant(1)]} />);
    const el = container.querySelector(".ai-messages") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 100 });
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    rerender(<MessageList messages={[assistant(1), assistant(2)]} />);
    expect(el.scrollTop).toBe(0);
    rerender(<MessageList messages={[assistant(1), assistant(2), user(3)]} />);
    expect(el.scrollTop).toBe(1000);
  });
});
