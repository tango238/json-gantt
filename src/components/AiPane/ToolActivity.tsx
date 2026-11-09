import { t } from "../../i18n";
import type { AiMessage } from "../../ai/types";

type ToolMsg = Extract<AiMessage, { kind: "tool" }>;

function label(m: ToolMsg): string {
  const target = m.target ?? "";
  if (m.name === "Read") return t("ai.tool.read", { target });
  if (m.name === "Edit" || m.name === "Write") return t("ai.tool.edit", { target });
  return t("ai.tool.other", { name: m.target ? `${m.name} ${m.target}` : m.name });
}

/** One progress line of a tool call (read / edit ...). */
export function ToolActivity({ msg }: { msg: ToolMsg }) {
  return (
    <div className={`ai-tool ai-tool-${msg.state}`}>
      <span>{label(msg)}</span>
      <span className="ai-tool-mark" aria-hidden="true">
        {msg.state === "running" ? "…" : msg.state === "done" ? "✓" : ""}
      </span>
      {msg.state === "error" && <span className="ai-tool-err">{t("ai.tool.error")}</span>}
    </div>
  );
}
