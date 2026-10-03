import { ANTHROPIC_URL, anthropicBody, anthropicHeaders } from "./schemas.mjs";
import { estimateCostUsd } from "./cost.mjs";

const ACTIONS = Object.freeze({
  screenshot: "desktop.screenshot",
  left_click: "desktop.click",
  click: "desktop.click",
  type: "desktop.type",
  key: "desktop.key",
  scroll: "desktop.scroll",
});

function mapInput(input) {
  if (!input || typeof input !== "object") return null;
  const tool = ACTIONS[input.action];
  if (!tool) return null;
  const args = {};
  if (Array.isArray(input.coordinate)) {
    args.x = input.coordinate[0];
    args.y = input.coordinate[1];
  }
  if (typeof input.text === "string") args.text = input.text;
  if (typeof input.x === "number") args.x = input.x;
  if (typeof input.y === "number") args.y = input.y;
  return { tool, args, id: input.id ?? null };
}

export function createAnthropicProvider({ key, model, fetchImpl }) {
  const messages = [];
  const pendingIds = [];
  return {
    name: "anthropic",
    computerUse: true,
    async next({ task, observations }) {
      if (messages.length === 0) messages.push({ role: "user", content: task });
      else if (observations.length > 0) {
        messages.push({
          role: "user",
          content: observations.map((observation, index) => ({
            type: "tool_result",
            tool_use_id: pendingIds[index] ?? observation.id ?? "tool",
            content: JSON.stringify(observation.result ?? { ok: observation.ok === true }),
          })),
        });
        pendingIds.length = 0;
      }
      const body = anthropicBody({ model, messages });
      const response = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        headers: anthropicHeaders(key),
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) return { requestBody: body, actions: [], text: "", error: "The provider refused the request.", costUsd: 0 };
      const actions = [];
      let text = "";
      for (const block of value?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") text += block.text;
        if (block?.type === "tool_use") {
          const mapped = mapInput(block.input);
          if (!mapped) continue;
          pendingIds.push(block.id ?? mapped.id ?? "tool");
          actions.push({ tool: mapped.tool, args: mapped.args, id: block.id ?? null });
        }
      }
      messages.push({ role: "assistant", content: value?.content ?? [] });
      return { requestBody: body, actions, text, costUsd: estimateCostUsd("anthropic", value?.usage) };
    },
  };
}
