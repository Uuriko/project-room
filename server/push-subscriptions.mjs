// Push subscriptions: validate them, decide what a push may say, deliver it,
// and retire the ones the push service says are dead.
//
// This is the half of delivery that is not cryptography. server/web-push.mjs
// turns a payload into an encrypted request; this module decides which payload,
// to whom, and what to do with the answer.
//
// Three decisions are worth stating, because each is easy to get wrong in a way
// that shows up months later:
//
// 1. A push carries no room content. RFC 8291 encryption means the push service
//    cannot read the payload, but the payload still lands on a device and is
//    shown, often on a locked screen, to whoever is holding it. So a push says
//    how much is waiting and where, never what was said. The member follows it
//    back into the room and re-authenticates, which is the only place the
//    content is ever released. tests/push-subscriptions.test.js asserts this
//    against a deliberately quotable message rather than trusting the comment.
//
// 2. Dead subscriptions are retired on the push service's word. A browser that
//    has been cleared, reinstalled or revoked answers 404 or 410 forever. Left
//    in place they accumulate, every send burns a request on them, and delivery
//    rate silently decays. 404/410 is the only signal we get and it is
//    authoritative, so it retires the record.
//
// 3. Nothing here blocks on the network. Every request is bounded by a timeout
//    and one unreachable push service cannot stall the others or take down the
//    caller. A send that fails is reported, never thrown.

import { buildPushRequest, constants, fromBase64Url } from "./web-push.mjs";

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_ENDPOINT_LENGTH = 2048;
// RFC 8291 section 4: a receiver must accept 4096 octets of payload, so that is
// the practical ceiling. Anything larger is refused before it is encrypted.
const MAX_PAYLOAD_BYTES = 3993;

export const DELIVERY_OUTCOMES = Object.freeze(["delivered", "retired", "retry", "failed"]);

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class PushSubscriptionError extends Error {
  constructor(code, message) { super(message); this.name = "PushSubscriptionError"; this.code = code; }
}

const refuse = (code, message) => { throw new PushSubscriptionError(code, message); };

/**
 * Validate and canonicalise a subscription as the browser hands it over.
 *
 * Everything the crypto needs is checked here, at the edge, where a bad value
 * can still be answered with a 422. Past this point a malformed key would
 * surface as an encryption failure on a background send with nobody watching.
 */
export function normaliseSubscription(raw, { now = Date.now(), memberId = null } = {}) {
  if (!raw || typeof raw !== "object") refuse("push_subscription_invalid", "Send the subscription object from the browser");
  const endpoint = raw.endpoint;
  if (typeof endpoint !== "string" || !endpoint) refuse("push_endpoint_required", "The subscription has no endpoint");
  if (endpoint.length > MAX_ENDPOINT_LENGTH) refuse("push_endpoint_too_long", "That endpoint is longer than any push service issues");

  let url;
  try { url = new URL(endpoint); } catch { refuse("push_endpoint_invalid", "That endpoint is not a URL"); }
  if (url.protocol !== "https:") refuse("push_endpoint_not_https", "Push endpoints are https");

  const keys = raw.keys;
  if (!keys || typeof keys !== "object") refuse("push_keys_required", "The subscription has no keys");

  let p256dh;
  let auth;
  try { p256dh = fromBase64Url(String(keys.p256dh ?? "")); }
  catch { refuse("push_key_p256dh_invalid", "The p256dh key is not base64url"); }
  try { auth = fromBase64Url(String(keys.auth ?? "")); }
  catch { refuse("push_key_auth_invalid", "The auth secret is not base64url"); }

  // An uncompressed P-256 point, and the 16-octet auth secret RFC 8291 fixes.
  if (p256dh.length !== constants.P256_PUBLIC_BYTES || p256dh[0] !== 0x04) refuse("push_key_p256dh_invalid", "The p256dh key is not an uncompressed P-256 point");
  if (auth.length !== constants.AUTH_SECRET_BYTES) refuse("push_key_auth_invalid", `The auth secret must be ${constants.AUTH_SECRET_BYTES} octets`);

  const expirationTime = raw.expirationTime ?? null;
  if (expirationTime !== null && !Number.isFinite(Number(expirationTime))) refuse("push_expiration_invalid", "expirationTime is a timestamp or null");

  return {
    // The endpoint identifies the subscription; a browser that re-subscribes
    // with the same endpoint is the same device, so keying on it makes save
    // idempotent instead of accumulating duplicates that each get their own push.
    id: endpoint,
    endpoint,
    origin: url.origin,
    keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
    expirationTime: expirationTime === null ? null : Number(expirationTime),
    memberId,
    createdAt: now
  };
}

export const subscriptionExpired = (subscription, now = Date.now()) =>
  subscription?.expirationTime !== null && subscription?.expirationTime !== undefined && Number(subscription.expirationTime) <= now;

// ---------------------------------------------------------------------------
// What a push is allowed to say
// ---------------------------------------------------------------------------

/**
 * Build the payload for one member from the notification read model.
 *
 * Input is the object server/notifications.mjs already returns, so this joins
 * the existing feed rather than deriving a second, divergent one. Output is
 * counts and identifiers only: no message body, no display name, no work title.
 *
 * `sequence` lets the client drop a push it has already overtaken, which is
 * what stops a stale wake from re-badging a room the member has since read.
 */
export function pushPayloadFor({ roomId, unread, notifications = [], sequence = null } = {}) {
  if (typeof roomId !== "string" || !roomId) refuse("push_payload_room_required", "A push names the room it is about");
  const counts = {};
  for (const item of notifications) {
    if (!item?.kind) continue;
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  const total = Number.isInteger(unread) ? unread : notifications.length;
  return {
    v: 1,
    roomId,
    unread: total,
    counts,
    // The newest event the count was evaluated through, not its contents.
    sequence: Number.isInteger(sequence) ? sequence : null
  };
}

export function encodePayload(payload) {
  const encoded = textEncoder.encode(JSON.stringify(payload));
  if (encoded.length > MAX_PAYLOAD_BYTES) refuse("push_payload_too_large", "That payload is larger than a push service will carry");
  return encoded;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Classify a push service response.
 *
 * The distinction that matters is permanent versus temporary: a permanent
 * failure must retire the subscription or it is retried forever, and a
 * temporary one must not, or a push service having a bad hour costs every
 * member their notifications permanently.
 */
export function classifyResponse({ status, retryAfter = null }) {
  if (status >= 200 && status < 300) return { outcome: "delivered", status };
  // RFC 8030 section 7.3: the subscription is gone and will not come back.
  if (status === 404 || status === 410) return { outcome: "retired", status, reason: "subscription_gone" };
  if (status === 429) return { outcome: "retry", status, reason: "rate_limited", retryAfter };
  if (status === 413) return { outcome: "failed", status, reason: "payload_too_large" };
  if (status === 401 || status === 403) return { outcome: "failed", status, reason: "vapid_rejected" };
  if (status >= 500) return { outcome: "retry", status, reason: "push_service_unavailable", retryAfter };
  return { outcome: "failed", status, reason: "push_service_refused" };
}

const parseRetryAfter = (value, now) => {
  if (!value) return null;
  if (/^\d+$/.test(value)) return now + Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * Send one payload to one subscription.
 *
 * Never throws for a delivery problem: an unreachable push service, a timeout
 * and a refusal are all outcomes a caller has to record, not exceptions that
 * abandon the rest of the fan-out. Programmer errors (a malformed subscription,
 * an oversized payload) still throw, because those are bugs, not conditions.
 */
export async function deliverPush({
  subscription,
  payload,
  vapid,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
  ttlSeconds,
  urgency,
  topic
}) {
  if (typeof fetchImpl !== "function") refuse("push_fetch_unavailable", "No fetch implementation is available");
  if (subscriptionExpired(subscription, now)) {
    return { outcome: "retired", status: null, reason: "subscription_expired", endpoint: subscription.endpoint };
  }

  const request = await buildPushRequest({
    subscription,
    payload: payload === null || payload === undefined ? null : encodePayload(payload),
    vapid,
    now,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(topic === undefined ? {} : { topic })
  });

  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // Without this one unreachable endpoint hangs the whole run. A push that
      // is late is worthless anyway; better to record it and move on.
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      outcome: "retry",
      status: null,
      reason: timedOut ? "push_service_timeout" : "push_service_unreachable",
      endpoint: subscription.endpoint,
      error: String(error?.message ?? error)
    };
  }

  const classified = classifyResponse({
    status: response.status,
    retryAfter: parseRetryAfter(response.headers?.get?.("retry-after"), now)
  });
  return { ...classified, endpoint: subscription.endpoint };
}

/**
 * Fan one payload out to every subscription a member has.
 *
 * Sends run together: a member with a phone and a laptop should not wait for
 * the slower push service twice over. Every result is reported, and `retire`
 * lists exactly the endpoints the caller should now delete.
 */
export async function deliverToSubscriptions({ subscriptions = [], payload, vapid, fetchImpl, timeoutMs, now = Date.now(), ...options }) {
  const results = await Promise.all(subscriptions.map(subscription =>
    deliverPush({ subscription, payload, vapid, fetchImpl, timeoutMs, now, ...options })
      // A bug in one send must not lose the results of the others.
      .catch(error => ({ outcome: "failed", status: null, reason: "push_send_error", endpoint: subscription?.endpoint ?? null, error: String(error?.message ?? error) }))
  ));

  const tally = { delivered: 0, retired: 0, retry: 0, failed: 0 };
  for (const result of results) tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
  return {
    results,
    tally,
    retire: results.filter(result => result.outcome === "retired").map(result => result.endpoint),
    delivered: tally.delivered
  };
}

/**
 * Whether push delivery is configured at all.
 *
 * The whole feature ships dark: with no VAPID keys set, this is false, nothing
 * is sent and nothing fails. Turning it on is adding the secret, not deploying
 * different code.
 */
export function pushConfigured(env = {}) {
  return Boolean(env.ROOM_VAPID_PUBLIC_KEY && env.ROOM_VAPID_PRIVATE_KEY && env.ROOM_VAPID_SUBJECT);
}

export function vapidFromEnv(env = {}) {
  if (!pushConfigured(env)) return null;
  return {
    publicKey: env.ROOM_VAPID_PUBLIC_KEY,
    privateKey: env.ROOM_VAPID_PRIVATE_KEY,
    subject: env.ROOM_VAPID_SUBJECT
  };
}

export { PushSubscriptionError, MAX_PAYLOAD_BYTES };
