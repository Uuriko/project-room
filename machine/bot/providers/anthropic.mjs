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

// loop.mjs hands screenshots over as observation.image, a data URL
// (`data:<media-type>;base64,<data>`), while observation.result is only the
// { image: true, bytes } summary. Anthropic takes the picture as an image
// block inside the tool_result, so decode the data URL back into that shape.
// Anything that is not a well-formed base64 data URL yields no block: the
// observation still goes back as plain text rather than a broken image the
// API would reject.
function imageBlock(image) {
  if (typeof image !== "string") return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) return null;
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
}

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
          content: observations.map((observation, index) => {
            const text = JSON.stringify(observation.result ?? { ok: observation.ok === true });
            const image = imageBlock(observation.image);
            return {
              type: "tool_result",
              tool_use_id: pendingIds[index] ?? observation.id ?? "tool",
              content: image ? [{ type: "text", text }, image] : text,
            };
          }),
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
