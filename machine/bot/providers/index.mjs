import { MISSING_KEY_MESSAGE } from "./schemas.mjs";
import { createAnthropicProvider } from "./anthropic.mjs";
import { createOpenAiProvider } from "./openai.mjs";
import { createLocalProvider, detectLocalModel } from "./local.mjs";
import { createDashaProvider } from "./dasha.mjs";
import { createNoneProvider } from "./none.mjs";

export async function createProvider({ name, key, model, fetchImpl }) {
  if (name === "anthropic") {
    if (!key) return { ...createNoneProvider(), name: "anthropic", message: MISSING_KEY_MESSAGE, missingKey: true };
    return createAnthropicProvider({ key, model: model || "claude-sonnet-4-5", fetchImpl });
  }
  if (name === "openai") {
    if (!key) return { ...createNoneProvider(), name: "openai", message: MISSING_KEY_MESSAGE, missingKey: true };
    return createOpenAiProvider({ key, model: model || "gpt-5.4", fetchImpl });
  }
  if (name === "dasha") {
    if (!key) return { ...createNoneProvider(), name: "dasha", message: MISSING_KEY_MESSAGE, missingKey: true };
    return createDashaProvider({ key, model: model || "room-bot", fetchImpl });
  }
  if (name === "local") {
    const detected = await detectLocalModel(fetchImpl, model);
    if (!detected.model) return { ...createNoneProvider(), name: "local", message: "No local model answered on this machine. I will not invent one.", missingKey: false };
    return createLocalProvider({ model: detected.model, vision: detected.vision, fetchImpl });
  }
  return createNoneProvider();
}
