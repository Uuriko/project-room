// Inbound Messenger ingestion: recorded webhook bodies -> channel envelopes.
// Pure and fixture-driven: no HTTP, no secrets at rest. The app secret used
// for X-Hub-Signature-256 verification is passed in per call, never stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import { messengerConnection, normalizeMessengerWebhook } from "./channel-adapters/messenger.mjs";
import { requireContract } from "./channel-connection.mjs";

// X-Hub-Signature-256: "sha256=" + hex(HMAC-SHA256(appSecret, rawBody)).
// rawBody is the exact request bytes (string or Buffer); the fixture path
// passes the recorded body text.
export function messengerSignature(appSecret, rawBody) {
  requireContract(typeof appSecret === "string" && appSecret.length > 0, "invalid_messenger_signature_input");
  requireContract(typeof rawBody === "string" || Buffer.isBuffer(rawBody), "invalid_messenger_signature_input");
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
export function verifyMessengerSignature(appSecret, rawBody, header) {
  requireContract(typeof header === "string", "invalid_messenger_signature_input");
  const expected = messengerSignature(appSecret, rawBody);
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(header, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// One recorded webhook body -> envelopes; skipped (unknown) events are
// reported with their page so the importer can log them, not import them.
export function ingestMessenger(connection, payload) {
  const profile = messengerConnection(connection);
  return normalizeMessengerWebhook(profile, payload);
}
// A batch of recorded webhook bodies -> envelopes in order; rejected bodies
// are collected with their index so the importer can quarantine them.
export function ingestMessengerBatch(connection, payloads) {
  const profile = messengerConnection(connection);
  requireContract(Array.isArray(payloads) && payloads.length <= 1000, "invalid_messenger_batch");
  const envelopes = [], skipped = [], rejected = [];
  payloads.forEach((payload, index) => {
    try {
      const { envelopes: batch, skipped: batchSkipped } = ingestMessenger(profile, payload);
      envelopes.push(...batch);
      skipped.push(...batchSkipped.map(s => ({ index, ...s })));
    } catch (error) { rejected.push({ index, code: error?.code ?? "unknown" }); }
  });
  return { envelopes, skipped, rejected };
}
