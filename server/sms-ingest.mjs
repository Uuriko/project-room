// Inbound SMS ingestion: recorded gateway payloads -> channel envelopes.
// Pure and fixture-driven: no HTTP, no secrets at rest. The Twilio request
// signature secret is passed in per call, never stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeSmsStatusCallback, normalizeSmsWebhook, smsConnection } from "./channel-adapters/sms.mjs";
import { requireContract } from "./channel-connection.mjs";

// Twilio request validation: HMAC-SHA1 over the full webhook URL with POST
// parameters sorted by name appended, keyed by the account auth token,
// base64-encoded. Compare with the X-Twilio-Signature header.
export function twilioSignature(secret, url, params) {
  requireContract(typeof secret === "string" && secret.length > 0, "invalid_sms_signature_input");
  requireContract(typeof url === "string" && url.length > 0, "invalid_sms_signature_input");
  requireContract(params !== null && typeof params === "object" && !Array.isArray(params), "invalid_sms_signature_input");
  const body = Object.keys(params).sort().map(k => k + String(params[k])).join("");
  return createHmac("sha1", secret).update(url + body, "utf8").digest("base64");
}
export function verifyTwilioSignature(secret, url, params, signature) {
  requireContract(typeof signature === "string", "invalid_sms_signature_input");
  const expected = twilioSignature(secret, url, params);
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Classify a recorded payload: an inbound message webhook carries Body (or
// NumSegments) without MessageStatus; a delivery callback carries
// MessageStatus. Anything else is rejected, never guessed.
export function classifySmsPayload(payload) {
  requireContract(payload !== null && typeof payload === "object" && !Array.isArray(payload), "invalid_sms_payload");
  const isCallback = typeof payload.MessageStatus === "string";
  const isInbound = typeof payload.Body === "string" || typeof payload.NumSegments === "number";
  requireContract(isCallback !== isInbound, "invalid_sms_payload");
  return isCallback ? "delivery_receipt" : "message";
}
// One recorded payload -> exactly one envelope.
export function ingestSms(connection, payload) {
  const profile = smsConnection(connection);
  const kind = classifySmsPayload(payload);
  return kind === "delivery_receipt" ? normalizeSmsStatusCallback(profile, payload) : normalizeSmsWebhook(profile, payload);
}
// A batch of recorded payloads -> envelopes in order; rejected payloads are
// collected with their index so the importer can quarantine them.
export function ingestSmsBatch(connection, payloads) {
  const profile = smsConnection(connection);
  requireContract(Array.isArray(payloads) && payloads.length <= 1000, "invalid_sms_batch");
  const envelopes = [], rejected = [];
  payloads.forEach((payload, index) => {
    try { envelopes.push(ingestSms(profile, payload)); }
    catch (error) { rejected.push({ index, code: error?.code ?? "unknown" }); }
  });
  return { envelopes, rejected };
}
