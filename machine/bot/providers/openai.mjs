import { OPENAI_URL, openaiBody, openaiHeaders } from "./schemas.mjs";
import { estimateCostUsd } from "./cost.mjs";

const ACTIONS = Object.freeze({
  screenshot: "desktop.screenshot",
  click: "desktop.click",
  double_click: "desktop.click",
  move: "desktop.click",
  drag: "desktop.click",
  scroll: "desktop.scroll",
  keypress: "desktop.key",
  type: "desktop.type",
  wait: null,
});

function mapAction(action) {
  if (!action || typeof action !== "object") return null;
  const tool = ACTIONS[action.type];
  if (tool === undefined) return null;
  if (tool === null) return { tool: "desktop.key", args: { key: "wait" }, skip: true };
  const args = {};
  if (typeof action.x === "number") args.x = action.x;
  if (typeof action.y === "number") args.y = action.y;
  if (typeof action.text === "string") args.text = action.text;
  if (Array.isArray(action.keys)) args.key = action.keys.join("+");
  return { tool, args };
}

export function createOpenAiProvider({ key, model, fetchImpl }) {
  let input = [];
  let responseId = null;
  return {
    name: "openai",
    computerUse: true,
    async next({ task, observations }) {
      if (input.length === 0) input = [{ role: "user", content: task }];
      else if (observations.length > 0) {
        input = observations.map(observation => ({
          type: "computer_call_output",
          call_id: observation.callId ?? "call",
          output: {
            type: "computer_screenshot",
            image_url: observation.image ?? "data:image/png;base64,",
          },
        }));
      }
      const body = openaiBody({ model, input });
      if (responseId) body.previous_response_id = responseId;
      const response = await fetchImpl(OPENAI_URL, {
        method: "POST",
        headers: openaiHeaders(key),
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) return { requestBody: body, actions: [], text: "", error: "The provider refused the request.", costUsd: 0 };
      responseId = value?.id ?? responseId;
      const actions = [];
      let text = "";
      for (const item of value?.output ?? []) {
        if (item?.type === "computer_call") {
          for (const action of item.actions ?? []) {
            const mapped = mapAction(action);
            if (!mapped || mapped.skip) continue;
            actions.push({ tool: mapped.tool, args: mapped.args, callId: item.call_id ?? item.id ?? null });
          }
        }
        if (item?.type === "message") {
          for (const part of item.content ?? []) {
            if (typeof part.text === "string") text += part.text;
          }
        }
      }
      return { requestBody: body, actions, text, costUsd: estimateCostUsd("openai", value?.usage) };
    },
  };
}
