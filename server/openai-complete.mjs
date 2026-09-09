const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const KEY_ENV = "PROJECT_ROOM_OPENAI_API_KEY";
const MODEL_ENV = "ROOM_OPENAI_MODEL";

export class MissingOpenAIKeyError extends Error {
  constructor() {
    super(`${KEY_ENV} is not set`);
    this.name = "MissingOpenAIKeyError";
    this.code = "missing_openai_key";
  }
}

export function readOpenAIKey(env = process.env) {
  const key = env[KEY_ENV];
  return typeof key === "string" && key.trim() ? key : null;
}

function assistantText(payload) {
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("OpenAI returned no assistant text");
  }
  return text;
}

// Reads only PROJECT_ROOM_OPENAI_API_KEY. Importing this module does nothing.
// A missing key refuses the completion; it does not invent a reply.
export async function completeChat({ messages, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const key = readOpenAIKey(env);
  if (!key) throw new MissingOpenAIKeyError();
  const response = await fetchImpl(OPENAI_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env[MODEL_ENV] || DEFAULT_MODEL,
      messages
    })
  });
  if (!response.ok) throw new Error("OpenAI completion failed");
  return assistantText(await response.json());
}

export { OPENAI_URL, DEFAULT_MODEL, KEY_ENV, MODEL_ENV };
