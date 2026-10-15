import { DASHA_URL, dashaBody, dashaHeaders } from "./schemas.mjs";

export function createDashaProvider({ key, model, fetchImpl }) {
  const messages = [];
  let currentTask = null;
  return {
    name: "dasha",
    computerUse: false,
    reset() {
      messages.length = 0;
      currentTask = null;
    },
    async next({ task, observations }) {
      // A different task starts a fresh conversation: the cached provider
      // must not resend the previous task's history or drop the new task.
      if (task !== currentTask) {
        messages.length = 0;
        currentTask = task;
      }
      if (messages.length === 0) messages.push({ role: "user", content: task });
      else if (observations.length > 0) {
        messages.push({
          role: "user",
          content: observations.map(observation => `${observation.tool}: ${JSON.stringify(observation.result ?? {})}`).join("\n"),
        });
      }
      const body = dashaBody({ model, messages });
      const response = await fetchImpl(DASHA_URL, {
        method: "POST",
        headers: dashaHeaders(key),
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) return { requestBody: body, actions: [], text: "", error: "The provider refused the request.", costUsd: 0 };
      const text = value?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text) messages.push({ role: "assistant", content: text });
      return { requestBody: body, actions: [], text: typeof text === "string" ? text : "", costUsd: 0 };
    },
  };
}
