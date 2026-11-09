import { memo, useLayoutEffect, useRef } from "react";
import type { AiMessage } from "../../ai/types";
import { t } from "../../i18n";
import { ResultCard } from "./ResultCard";
import { ToolActivity } from "./ToolActivity";

const FOLLOW_THRESHOLD = 40;

export const MessageList = memo(function MessageList({ messages }: { messages: readonly AiMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD;
  };
  // Follow new messages unless the user scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A message the user just sent always scrolls to the bottom.
    if (messages[messages.length - 1]?.kind === "user") follow.current = true;
    if (follow.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="ai-messages" role="log" aria-live="polite" ref={ref} onScroll={onScroll}>
      {messages.map((m) => {
        switch (m.kind) {
          case "user":
            return (
              <div key={m.id} className="ai-bubble ai-user">
                {m.text}
              </div>
            );
          case "assistant":
            return (
              <div key={m.id} className="ai-bubble ai-assistant">
                {m.text}
              </div>
            );
          case "tool":
            return <ToolActivity key={m.id} msg={m} />;
          case "result":
            return <ResultCard key={m.id} msg={m} />;
          case "notice":
            return (
              <div key={m.id} className="ai-notice">
                {t(m.textKey, m.params)}
              </div>
            );
        }
      })}
    </div>
  );
});
