// Telegram webhook secret rotation. The plaintext secret never reaches the
// server: rotation records keep only SHA-256 digests on `connection.webhook`
// (`secretHash` plus, while a rotation is pending, `previousSecretHash` with a
// `rotationExpiresAt` deadline). Incoming deliveries dual-accept both digests
// until the window ends; re-registration with Telegram stays on the existing
// setWebhook path (scripts/telegram-set-webhook.mjs), and the connection card
// surfaces the rotation state through `webhookRotationView`.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { validateWebhookSecret } from "../channel-import.mjs";

const sha256hex = value => createHash("sha256").update(value).digest("hex");
const hex64 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? Buffer.from(value, "hex") : null;
const iso = ms => Number.isSafeInteger(ms) ? new Date(ms).toISOString() : null;

// Rotation windows: long enough to cover Telegram's secret_token propagation
// and retried in-flight deliveries, short enough to bound old-secret exposure.
// The floor only rules out nonsense; operators should use the 24h default.
export const webhookRotationDefaults = Object.freeze({ windowMs: 24 * 3600 * 1000, minWindowMs: 1000, maxWindowMs: 7 * 24 * 3600 * 1000, secretBytes: 32 });

// A fresh crypto-secure secret: 32 random bytes as base64url (43 characters of
// A-Z a-z 0-9 _ -), always passing the server's webhook-secret strength gate.
// The operator stores it as TELEGRAM_WEBHOOK_SECRET; the server only ever sees
// its digest.
export function generateWebhookSecret(bytes = webhookRotationDefaults.secretBytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 64) throw new Error("Choose 16 to 64 secret bytes.");
  for (let attempt = 0; attempt < 10; attempt++) {
    const secret = randomBytes(bytes).toString("base64url");
    if (validateWebhookSecret(secret)) return secret;
  }
  throw new Error("Could not generate a strong webhook secret.");
}
// The digest the server compares, mirroring ChannelWebhookInbox.hash: the only
// place a plaintext candidate is hashed, and it never persists the plaintext.
export function hashRotationSecret(secret) {
  if (!validateWebhookSecret(secret)) throw new Error("Choose a webhook secret of 16 to 256 characters without whitespace and with at least 6 distinct characters.");
  return sha256hex(secret);
}
// Begin a rotation: the new digest verifies immediately, the previous digest
// stays accepted until `rotationExpiresAt`. A rotation always supersedes an
// older one: the previous secret becomes the currently registered digest.
export function startWebhookRotation({ webhook, newSecretHash, windowMs = webhookRotationDefaults.windowMs, at = Date.now() }) {
  const previousSecretHash = webhook?.secretHash ?? null;
  if (!hex64(previousSecretHash)) throw new Error("A rotation needs a currently registered webhook secret; register the webhook first.");
  if (!hex64(newSecretHash)) throw new Error("Supply the new secret's SHA-256 hex digest.");
  if (previousSecretHash === newSecretHash) throw new Error("The new secret must differ from the current one.");
  if (!Number.isSafeInteger(windowMs) || windowMs < webhookRotationDefaults.minWindowMs || windowMs > webhookRotationDefaults.maxWindowMs)
    throw new Error("Choose a rotation window of 1 second to 7 days.");
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Supply a valid timestamp.");
  return { secretHash: newSecretHash, previousSecretHash, rotationExpiresAt: at + windowMs, rotationState: "pending", updatedAt: at };
}
// End a pending rotation early: the previous digest stops verifying at once.
// An expired window needs no call; verification already rejects the old digest.
export function completeWebhookRotation(webhook, at = Date.now()) {
  if (!hex64(webhook?.secretHash)) throw new Error("No webhook secret is registered.");
  if (webhook.rotationState !== "pending") throw new Error("No webhook rotation is pending.");
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Supply a valid timestamp.");
  return { secretHash: webhook.secretHash, rotationState: "complete", rotationCompletedAt: at, updatedAt: at };
}
// none: never rotated. pending: the previous digest still verifies. complete:
// the window ended (or was ended early) and only the current digest verifies.
export function webhookRotationState(webhook, now = Date.now()) {
  if (!webhook || typeof webhook !== "object") return "none";
  if (webhook.rotationState === "complete") return "complete";
  if (webhook.rotationState !== "pending") return "none";
  const open = hex64(webhook.previousSecretHash) !== null && Number.isSafeInteger(webhook.rotationExpiresAt) && now < webhook.rotationExpiresAt;
  return open ? "pending" : "complete";
}
// What the connection card shows: digests and states only, never values.
export function webhookRotationView(webhook, now = Date.now()) {
  const state = webhookRotationState(webhook, now);
  return { contractVersion: 1, state, windowExpiresAt: state === "pending" ? iso(webhook.rotationExpiresAt) : null };
}
// Signature verification for one presented digest: the current secret, or the
// previous secret while its rotation window is open. Constant-time compares.
export function webhookAcceptsHash(webhook, presentedHash, now = Date.now()) {
  const presented = hex64(presentedHash);
  if (!presented) return false;
  const current = hex64(webhook?.secretHash);
  if (current && timingSafeEqual(current, presented)) return true;
  if (webhookRotationState(webhook, now) !== "pending") return false;
  const previous = hex64(webhook.previousSecretHash);
  return previous !== null && timingSafeEqual(previous, presented);
}
