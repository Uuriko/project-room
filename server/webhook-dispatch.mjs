// Signed outbound webhook dispatch (RC-2026-09-19-064).
//
// The actual HTTP delivery engine for agent webhook subscriptions. The
// subscription surface (server/agent-webhook-subscriptions.mjs) builds and
// journals deliveries; this module signs them for the wire, POSTs them,
// and classifies the outcome so the caller can retry, dead-letter, or mark
// delivered. Pure and dependency-free apart from node:crypto; the fetch
// implementation is injected so tests never touch the network.
//
// Wire contract (what a receiver must implement):
//   POST {url} with JSON body
//     { deliveryId, subscriptionId, eventType, issuedAt, roomId, data }
//   and headers
//     x-webhook-delivery: <deliveryId>
//     x-webhook-subscription: <subscriptionId>
//     x-webhook-event: <eventType>
//     x-webhook-timestamp: <issuedAt as ISO-8601>
//     x-webhook-signature: sha256=<hex HMAC-SHA256>
//   The signature covers the canonical JSON of
//   { deliveryId, eventType, issuedAt, data } keyed by the subscription's
//   signing secret. Receivers MUST reject deliveries whose issuedAt is older
//   than REPLAY_TOLERANCE_MS (5 minutes) and SHOULD deduplicate on
//   deliveryId — the dispatcher may retry the same deliveryId and redrives
//   reuse it, so deliveryId is the idempotency key end to end.
import { createHmac, timingSafeEqual } from "node:crypto";

class WebhookDispatchError extends Error {
  constructor(code, message) { super(message); this.name = "WebhookDispatchError"; this.code = code; }
}
const fail = (code, message) => { throw new WebhookDispatchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dispatch", message); };

// Receivers reject anything older than this (replay resistance).
export const REPLAY_TOLERANCE_MS = 5 * 60 * 1000;
// A delivery is abandoned to the dead-letter queue after this many attempts.
export const MAX_DELIVERY_ATTEMPTS = 5;
// Per-attempt HTTP timeout.
export const DELIVERY_TIMEOUT_MS = 10 * 1000;
// Backoff: 5s, 10s, 20s, 40s, 80s … capped at 10 minutes.
const BACKOFF_BASE_MS = 5 * 1000;
const BACKOFF_CAP_MS = 10 * 60 * 1000;
export const backoffDelayMs = attempts => {
  check(Number.isInteger(attempts) && attempts >= 0, "attempts must be a non-negative integer");
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
};

const canonicalPayload = ({ deliveryId, eventType, issuedAt, data }) =>
  JSON.stringify({ deliveryId, eventType, issuedAt, data });

// Sign a delivery for the wire. issuedAt is a unix-ms timestamp; including
// it (plus the deliveryId nonce) in the signed body is what makes
// deliveries replay-resistant.
export function signDelivery(secret, { deliveryId, eventType, issuedAt, data }) {
  check(typeof secret === "string" && secret.length > 0, "secret is required");
  check(typeof deliveryId === "string" && deliveryId.length > 0, "deliveryId must be a non-empty string");
  check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
  check(Number.isInteger(issuedAt) && issuedAt > 0, "issuedAt must be a positive integer timestamp");
  check(data !== null && typeof data === "object", "data must be an object");
  return createHmac("sha256", secret)
    .update(canonicalPayload({ deliveryId, eventType, issuedAt, data }))
    .digest("hex");
}

// Timing-safe verification of an inbound delivery signature.
export function verifyDeliverySignature(secret, signature, { deliveryId, eventType, issuedAt, data }) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string" || signature.length === 0) return false;
  let expected;
  try {
    expected = signDelivery(secret, { deliveryId, eventType, issuedAt, data });
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Freshness check for receivers: reject deliveries older than the tolerance.
export function isFresh(issuedAt, now = Date.now()) {
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return false;
  if (!Number.isInteger(now) || now <= 0) return false;
  return Math.abs(now - issuedAt) <= REPLAY_TOLERANCE_MS;
}

// The POST body for a delivery. Frozen; roomId is null for identity-scoped
// deliveries (e.g. agent.wake) that are not tied to a room event.
export function deliveryEnvelope({ deliveryId, subscriptionId, eventType, issuedAt, roomId = null, data }) {
  check(typeof deliveryId === "string" && deliveryId.length > 0, "deliveryId must be a non-empty string");
  check(typeof subscriptionId === "string" && subscriptionId.length > 0, "subscriptionId must be a non-empty string");
  check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
  check(Number.isInteger(issuedAt) && issuedAt > 0, "issuedAt must be a positive integer timestamp");
  check(roomId === null || typeof roomId === "string", "roomId must be a string or null");
  check(data !== null && typeof data === "object", "data must be an object");
  return Object.freeze({ deliveryId, subscriptionId, eventType,
    issuedAt: new Date(issuedAt).toISOString(), roomId, data: Object.freeze({ ...data }) });
}

export function deliveryHeaders({ deliveryId, subscriptionId, eventType, issuedAt, signature }) {
  check(typeof deliveryId === "string" && deliveryId.length > 0, "deliveryId must be a non-empty string");
  check(typeof subscriptionId === "string" && subscriptionId.length > 0, "subscriptionId must be a non-empty string");
  check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
  check(Number.isInteger(issuedAt) && issuedAt > 0, "issuedAt must be a positive integer timestamp");
  check(typeof signature === "string" && /^[0-9a-f]{64}$/.test(signature), "signature must be a 64-char hex string");
  return Object.freeze({
    "content-type": "application/json",
    "x-webhook-delivery": deliveryId,
    "x-webhook-subscription": subscriptionId,
    "x-webhook-event": eventType,
    "x-webhook-timestamp": new Date(issuedAt).toISOString(),
    "x-webhook-signature": `sha256=${signature}`,
  });
}

// Classify an HTTP outcome: 2xx is delivered; 429 and 5xx are retryable;
// any other 4xx is a permanent rejection (the receiver understood the
// request and refused it — retrying the same bytes will not help).
// Network-level failures (status 0) are retryable.
export function classifyHttpStatus(status) {
  check(Number.isInteger(status) && status >= 0, "status must be a non-negative integer");
  if (status >= 200 && status < 300) return "delivered";
  if (status === 429 || (status >= 500 && status < 600) || status === 0) return "retry";
  return "dead";
}

// POST one delivery. Never throws for transport/HTTP failures — those come
// back as { ok: false }. Throws only for programmer errors (bad arguments).
export async function postDelivery({ fetchImpl, url, envelope, headers, timeoutMs = DELIVERY_TIMEOUT_MS }) {
  check(typeof fetchImpl === "function", "fetchImpl must be a function");
  check(typeof url === "string" && url.length > 0, "url must be a non-empty string");
  check(envelope !== null && typeof envelope === "object", "envelope must be an object");
  check(headers !== null && typeof headers === "object", "headers must be an object");
  check(Number.isInteger(timeoutMs) && timeoutMs > 0, "timeoutMs must be a positive integer");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "delivery timed out" : (error?.message ?? "network error");
    return { ok: false, status: 0, error: String(reason).slice(0, 500), classification: "retry" };
  }
  const status = Number(response?.status ?? 0);
  const classification = classifyHttpStatus(Number.isInteger(status) ? status : 0);
  if (classification === "delivered") return { ok: true, status, error: null };
  let detail = "";
  try {
    const text = await response.text();
    if (typeof text === "string" && text.length > 0) detail = `: ${text.slice(0, 200)}`;
  } catch { /* a body that cannot be read adds nothing */ }
  return { ok: false, status, error: `HTTP ${status}${detail}`.slice(0, 500),
    classification };
}

export { WebhookDispatchError };
