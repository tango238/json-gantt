/** One line of `claude -p --output-format stream-json` -> StreamEvent(s). Never throws. */

export interface ResultEvent {
  kind: "result";
  ok: boolean;
  subtype: string;
  sessionId: string | null;
  text: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  permissionDenials: number;
}

export type StreamEvent =
  | { kind: "init"; sessionId: string; model?: string; tools: string[] }
  | { kind: "text"; text: string }
  | { kind: "toolUse"; toolUseId: string; name: string; filePath: string | null }
  | { kind: "toolResult"; toolUseId: string; isError: boolean }
  | ResultEvent
  | { kind: "rateLimit"; status: string }
  | { kind: "ignored" }
  | { kind: "invalid"; line: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const IGNORED: StreamEvent = { kind: "ignored" };

function blocks(msg: unknown): Obj[] {
  if (!isObj(msg) || !Array.isArray(msg.content)) return [];
  return msg.content.filter(isObj);
}

function parseResult(o: Obj): ResultEvent {
  const subtype = str(o.subtype) ?? "";
  return {
    kind: "result",
    ok: subtype === "success" && o.is_error !== true,
    subtype,
    sessionId: str(o.session_id),
    text: str(o.result),
    costUsd: num(o.total_cost_usd),
    durationMs: num(o.duration_ms),
    numTurns: num(o.num_turns),
    permissionDenials: Array.isArray(o.permission_denials) ? o.permission_denials.length : 0,
  };
}

export function parseLine(line: string): StreamEvent[] {
  if (line.trim() === "") return [IGNORED];
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return [{ kind: "invalid", line }];
  }
  if (!isObj(o)) return [IGNORED];
  if (o.parent_tool_use_id !== undefined && o.parent_tool_use_id !== null) return [IGNORED];

  const out: StreamEvent[] = [];
  switch (o.type) {
    case "system": {
      const sid = str(o.session_id);
      if (o.subtype === "init" && sid !== null) {
        const model = str(o.model);
        out.push({
          kind: "init",
          sessionId: sid,
          ...(model !== null ? { model } : {}),
          tools: Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === "string") : [],
        });
      }
      break;
    }
    case "assistant":
      for (const b of blocks(o.message)) {
        if (b.type === "text") {
          const text = str(b.text);
          if (text !== null && text.trim() !== "") out.push({ kind: "text", text });
        } else if (b.type === "tool_use") {
          const id = str(b.id);
          const name = str(b.name);
          if (id !== null && name !== null) {
            out.push({
              kind: "toolUse",
              toolUseId: id,
              name,
              filePath: isObj(b.input) ? str(b.input.file_path) : null,
            });
          }
        }
      }
      break;
    case "user":
      for (const b of blocks(o.message)) {
        const id = str(b.tool_use_id);
        if (b.type === "tool_result" && id !== null) {
          out.push({ kind: "toolResult", toolUseId: id, isError: b.is_error === true });
        }
      }
      break;
    case "result":
      out.push(parseResult(o));
      break;
    case "rate_limit_event": {
      const info = o.rate_limit_info;
      out.push({ kind: "rateLimit", status: (isObj(info) ? str(info.status) : null) ?? "unknown" });
      break;
    }
  }
  return out.length > 0 ? out : [IGNORED];
}
