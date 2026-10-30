// Turn ACP session/update notifications into one compact Room reply.
// Agent thoughts are never posted. Tool calls and plan steps become a short
// trailer (at most TRAILER_LINES lines) under the agent's own text.
export const MAX_BODY_CHARS = 6000;
export const TRAILER_LINES = 10;

export class TurnRecorder {
  constructor() { this.text = ""; this.tools = new Map(); this.plan = []; }
  update(update) {
    switch (update?.sessionUpdate) {
      case "agent_message_chunk": if (update.content?.type === "text") this.text += update.content.text; break;
      case "tool_call": this.tools.set(update.toolCallId, { title: update.title ?? update.kind ?? "tool", status: update.status ?? "pending" }); break;
      case "tool_call_update": {
        const tool = this.tools.get(update.toolCallId) ?? { title: update.title ?? "tool", status: "pending" };
        this.tools.set(update.toolCallId, { title: update.title ?? tool.title, status: update.status ?? tool.status });
        break;
      }
      case "plan": this.plan = Array.isArray(update.entries) ? update.entries : []; break;
      default: break; // agent_thought_chunk, user_message_chunk, mode/commands updates: not posted
    }
  }
}

const oneLine = text => String(text).replace(/\s+/g, " ").trim().slice(0, 120);
const mark = status => (status === "completed" ? "✓" : status === "failed" ? "✗" : "…");

export function renderTurn(recorder, { stopReason = "end_turn", error = null } = {}) {
  let body = recorder.text.trim();
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n… (reply cut at ${MAX_BODY_CHARS} characters)`;
  const lines = [];
  const tools = [...recorder.tools.values()];
  for (const tool of tools.slice(0, TRAILER_LINES - 1)) lines.push(`${mark(tool.status)} ${oneLine(tool.title)}`);
  if (tools.length > TRAILER_LINES - 1) lines.push(`… and ${tools.length - (TRAILER_LINES - 1)} more tool calls`);
  const trailer = lines.slice(0, TRAILER_LINES);
  const notes = [];
  if (error) notes.push(`(turn failed: ${oneLine(error)})`);
  else if (stopReason === "cancelled") notes.push("(turn cancelled)");
  else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") notes.push(`(stopped early: ${stopReason})`);
  else if (stopReason === "refusal") notes.push("(the agent declined)");
  if (!body && !trailer.length && !notes.length) body = "(no reply text)";
  return [body, trailer.length ? `\n${trailer.join("\n")}` : "", ...notes].filter(Boolean).join("\n").trim();
}
