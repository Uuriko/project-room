import { OLLAMA_CHAT_URL, OLLAMA_TAGS_URL, localBody } from "./schemas.mjs";

const TOOLS = Object.freeze({
  shell_vm: "shell.vm",
  files_get: "files.get",
  files_put: "files.put",
  screenshot: "desktop.screenshot",
});

const VISION_NAME = /llava|vision|vl|gemma3/i;

export function reportedVision(tags) {
  const models = tags?.models ?? [];
  return models.some(model => VISION_NAME.test(String(model?.name ?? "")));
}

export function createLocalProvider({ model, vision, fetchImpl }) {
  const messages = [];
  return {
    name: "local",
    computerUse: vision === true,
    async next({ task, observations }) {
      if (messages.length === 0) messages.push({ role: "user", content: task });
      else if (observations.length > 0) {
        messages.push({
          role: "tool",
          content: observations.map(observation => `${observation.tool}: ${JSON.stringify(observation.result ?? {})}`).join("\n"),
        });
      }
      const body = localBody({ model, messages, vision: vision === true });
      const response = await fetchImpl(OLLAMA_CHAT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) return { requestBody: body, actions: [], text: "", error: "The local model did not answer.", costUsd: 0 };
      const message = value?.message ?? {};
      const actions = [];
      for (const call of message.tool_calls ?? []) {
        const name = call?.function?.name;
        const tool = TOOLS[name];
        if (!tool) continue;
        if (tool === "desktop.screenshot" && vision !== true) continue;
        const args = call.function?.arguments ?? {};
        actions.push({
          tool,
          args: typeof args === "string" ? { command: args } : args,
        });
      }
      if (message.content) messages.push({ role: "assistant", content: message.content });
      return { requestBody: body, actions, text: typeof message.content === "string" ? message.content : "", costUsd: 0 };
    },
  };
}

export async function detectLocalModel(fetchImpl, preferred) {
  try {
    const response = await fetchImpl(OLLAMA_TAGS_URL, { method: "GET" });
    const value = await response.json().catch(() => null);
    if (!response.ok) return { model: preferred || "", vision: false };
    const names = (value?.models ?? []).map(model => model?.name).filter(name => typeof name === "string");
    const model = preferred && names.includes(preferred) ? preferred : (names[0] ?? "");
    return { model, vision: reportedVision(value) };
  } catch {
    return { model: "", vision: false };
  }
}
