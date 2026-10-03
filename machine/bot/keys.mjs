import { saveSecret, readSecret } from "../lib/secrets.mjs";
import { configHome } from "../lib/config.mjs";

const KEYED = new Set(["anthropic", "openai", "dasha"]);

export function providerNeedsKey(name) {
  return KEYED.has(name);
}

export function providerAccount(name) {
  return `provider-${name}`;
}

export async function saveProviderKey(name, value, home = configHome()) {
  if (!providerNeedsKey(name)) return { ok: false, error: "no_key" };
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length < 8 || key.length > 400 || /[\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: "invalid_key" };
  await saveSecret(providerAccount(name), key, home);
  return { ok: true };
}

export async function readProviderKey(name, home = configHome()) {
  if (!providerNeedsKey(name)) return null;
  const value = await readSecret(providerAccount(name), home);
  return value && value.trim() ? value.trim() : null;
}
