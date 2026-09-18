// Per-agent webhook subscriptions (lane D).
//
// server/outbound-webhooks.mjs manages owner-level webhooks. This module is
// the agent-facing subscription surface: an enrolled agent subscribes its
// own endpoint to the room events it cares about, with HMAC-SHA256 signing
// for inbound delivery verification and a per-subscription delivery
// journal. URL validation reuses the owner module's rule (https only, no
// secrets in code); subscription secrets are caller-supplied or injected
// — never committed to the repo.
//
// Pure module: all state is caller-owned (a Map), no network I/O.
// Frozen outputs; malformed inputs throw WebhookSubscriptionError (coded).
import { createHmac, timingSafeEqual } from "node:crypto";
import { validateWebhookUrl } from "./outbound-webhooks.mjs";

class WebhookSubscriptionError extends Error {
  constructor(code, message) { super(message); this.name = "WebhookSubscriptionError"; this.code = code; }
}
const fail = (code, message) => { throw new WebhookSubscriptionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_subscription", message); };

const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Create an agent webhook subscription manager. store is a caller-owned Map.
export function createAgentWebhookSubscriptions({ store, clock, id } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  check(id === undefined || typeof id === "function", "id must be a function if given");
  const subs = store ?? new Map();
  const now = clock ?? Date.now;
  let counter = 0;
  const newId = id ?? (() => `sub_${(++counter).toString(36)}${Date.now().toString(36)}`);

  const subscriptionView = sub => Object.freeze({
    subscriptionId: sub.subscriptionId,
    agentId: sub.agentId,
    url: sub.url,
    events: Object.freeze([...sub.events]),
    enabled: sub.enabled,
    createdAt: sub.createdAt,
    deliveries: sub.deliveries.length,
  });

  // An agent subscribes its own endpoint to room events. secret (signing
  // secret for delivery verification) is caller-supplied; never echoed
  // back — only subscriptionView() leaves this module.
  const subscribe = ({ subscriptionId = null, agentId, url, events, secret }) => {
    check(typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId),
      "agentId must match [A-Za-z0-9_-]{1,64}");
    try {
      validateWebhookUrl(url);
    } catch (err) {
      fail("invalid_subscription", err.message);
    }
    check(Array.isArray(events) && events.length > 0 &&
      events.every(e => typeof e === "string" && e.length > 0),
      "events must be a non-empty string array");
    check(typeof secret === "string" && secret.length >= 16, "secret must be ≥16 chars");
    const sid = subscriptionId ?? newId();
    check(SUBSCRIPTION_ID_PATTERN.test(sid), "subscriptionId must match [A-Za-z0-9_-]{1,64}");
    check(!subs.has(sid), `subscription "${sid}" already exists`);
    const sub = {
      subscriptionId: sid,
      agentId,
      url,
      events: Object.freeze([...new Set(events)]),
      secret,
      enabled: true,
      createdAt: now(),
      deliveries: [],
    };
    subs.set(sid, sub);
    return subscriptionView(sub);
  };

  const mustOwn = (sub, agentId) => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    check(sub.agentId === agentId, "access_denied: agents may only manage their own subscriptions");
  };

  const unsubscribe = (subscriptionId, { agentId }) => {
    check(SUBSCRIPTION_ID_PATTERN.test(subscriptionId), "subscriptionId is invalid");
    const sub = subs.get(subscriptionId);
    check(sub, `unknown subscription "${subscriptionId}"`);
    mustOwn(sub, agentId);
    subs.delete(subscriptionId);
    return Object.freeze({ subscriptionId, unsubscribed: true });
  };

  const setEnabled = (subscriptionId, { agentId, enabled }) => {
    check(SUBSCRIPTION_ID_PATTERN.test(subscriptionId), "subscriptionId is invalid");
    const sub = subs.get(subscriptionId);
    check(sub, `unknown subscription "${subscriptionId}"`);
    mustOwn(sub, agentId);
    check(typeof enabled === "boolean", "enabled must be a boolean");
    sub.enabled = enabled;
    return subscriptionView(sub);
  };

  // List an agent's own subscriptions.
  const forAgent = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    return Object.freeze([...subs.values()]
      .filter(s => s.agentId === agentId)
      .map(subscriptionView));
  };

  // Match an event type against an agent's subscriptions (supports "*").
  const match = (agentId, eventType) => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
    return Object.freeze([...subs.values()]
      .filter(s => s.agentId === agentId && s.enabled &&
        (s.events.includes(eventType) || s.events.includes("*")))
      .map(subscriptionView));
  };

  // Build a signed delivery payload for a matched subscription.
  const buildDelivery = (subscriptionId, { eventType, data }) => {
    check(SUBSCRIPTION_ID_PATTERN.test(subscriptionId), "subscriptionId is invalid");
    const sub = subs.get(subscriptionId);
    check(sub, `unknown subscription "${subscriptionId}"`);
    check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
    check(data !== null && typeof data === "object", "data must be an object");
    const delivery = Object.freeze({
      deliveryId: `del_${newId()}`,
      subscriptionId,
      agentId: sub.agentId,
      url: sub.url,
      eventType,
      data: Object.freeze({ ...data }),
      signature: signPayload(sub.secret, { eventType, data }),
      state: "pending",
      attempts: 0,
      createdAt: now(),
    });
    sub.deliveries.push({ ...delivery, error: null });
    return delivery;
  };

  // Record a delivery attempt (the HTTP sender calls this after trying).
  const recordAttempt = (deliveryId, { ok, error = null }) => {
    check(typeof deliveryId === "string" && deliveryId.length > 0, "deliveryId must be a non-empty string");
    check(typeof ok === "boolean", "ok must be a boolean");
    for (const sub of subs.values()) {
      const idx = sub.deliveries.findIndex(d => d.deliveryId === deliveryId);
      if (idx >= 0) {
        const prior = sub.deliveries[idx];
        const updated = {
          ...prior,
          state: ok ? "delivered" : "failed",
          attempts: prior.attempts + 1,
          error: ok ? null : String(error ?? "delivery failed"),
        };
        sub.deliveries[idx] = updated;
        return Object.freeze({ deliveryId, state: updated.state, attempts: updated.attempts });
      }
    }
    fail("unknown_delivery", `unknown delivery "${deliveryId}"`);
  };

  // The per-subscription delivery journal (frozen; secrets never included).
  const journal = subscriptionId => {
    check(SUBSCRIPTION_ID_PATTERN.test(subscriptionId), "subscriptionId is invalid");
    const sub = subs.get(subscriptionId);
    check(sub, `unknown subscription "${subscriptionId}"`);
    return Object.freeze(sub.deliveries.map(d =>
      Object.freeze({ deliveryId: d.deliveryId, eventType: d.eventType,
        state: d.state, attempts: d.attempts, error: d.error, createdAt: d.createdAt })));
  };

  return Object.freeze({ subscribe, unsubscribe, setEnabled, forAgent, match, buildDelivery, recordAttempt, journal });
}

// Sign a delivery payload with the subscription secret (HMAC-SHA256).
// The agent verifies the same way on receipt.
export function signPayload(secret, { eventType, data }) {
  if (typeof secret !== "string" || secret.length === 0) throw new WebhookSubscriptionError("invalid_subscription", "secret is required");
  const canonical = JSON.stringify({ eventType, data });
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

// Timing-safe signature verification for inbound webhook deliveries.
export function verifySignature(secret, signature, { eventType, data }) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = signPayload(secret, { eventType, data });
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
export { WebhookSubscriptionError };
