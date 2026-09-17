const ENDPOINT = "https://api.openai.com/v1/chat/completions";

// Provider credentials never enter Room commands, prompts, or error messages.
export async function completeChat({ text, env = process.env, fetchImpl = globalThis.fetch, maxTokens = 256 }) {
  if (!env.PROJECT_ROOM_OPENAI_API_KEY?.trim()) throw new Error("PROJECT_ROOM_OPENAI_API_KEY is missing");
  if (typeof text !== "string" || !text.trim() || text.length > 4096) throw new Error("Use a nonempty prompt of at most 4096 characters");
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512) throw new Error("Output cap must be 1–512 tokens");
  const model = env.ROOM_OPENAI_MODEL || "gpt-4o-mini";
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.PROJECT_ROOM_OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, store: false, max_completion_tokens: maxTokens, messages: [
        { role: "system", content: "You are a Project Room assistant. Answer the addressed message briefly. You have no tools and cannot perform actions or approve work. Do not claim to have done so." },
        { role: "user", content: text }
      ] })
    });
  } catch { throw new Error("OpenAI request interrupted; outcome unknown"); }
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const payload = await response.json();
  const answer = payload?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("OpenAI returned no assistant text");
  return { text: answer.trim().slice(0, 4096), model, status: response.status };
}
