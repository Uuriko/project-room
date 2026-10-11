// Approval-inbox outbound webhooks (WAVE-500 guild 10).
//
// Opt-in outbound webhooks for approval-inbox card transitions
// (approval.card.opened / approval.card.decided / approval.card.expired).
// Room-level opt-in, default OFF: a room that never registered (or that
// disabled its registration) sends nothing — there is never surprise
// outbound traffic. On a transition the inbox store calls notify();
// delivery is fire-and-forget — it never blocks the decision path — and
// the terminal outcome (delivered/failed) is journaled to a caller-owned
// array.
//
// The wire contract is the repo's shared signed-webhook contract from
// server/webhook-dispatch.mjs: POST with JSON body
// { deliveryId, subscriptionId, eventType, issuedAt, roomId, data },
// x-webhook-signature: sha256=<hex HMAC-SHA256> over the canonical body,
// deliveryId as the end-to-end idempotency key, 5-minute replay tolerance.
// Receivers implement the same handler they already use for agent
// webhooks. URLs are validated with the repo's validateWebhookUrl
// (server/outbound-webhooks.mjs) at registration and re-validated at every
// dispatch by the default deliver step (postDelivery).
//
// Pure-ish: registration state and the journal are caller-owned; the
// dispatch step, clock, id generator, and sleep are injected so tests
// never touch the network or the wall clock.
import { randomUUID } from "node:crypto";
import { validateWebhookUrl } from "./outbound-webhooks.mjs";
import { signDelivery, deliveryEnvelope, deliveryHeaders, postDelivery, backoffDelayMs } from "./webhook-dispatch.mjs";

export class ApprovalInboxWebhookError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApprovalInboxWebhookError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new ApprovalInboxWebhookError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

// Card transitions that emit webhooks.
export const INBOX_WEBHOOK_EVENTS = Object.freeze([
  "approval.card.opened",
  "approval.card.decided",
  "approval.card.expired",
]);
// Per-attempt POST timeout (the shared dispatch engine defaults to 10s;
// inbox fan-out stays tighter).
export const INBOX_DELIVERY_TIMEOUT_MS = 5 * 1000;
// 1 initial attempt + up to 3 retries with exponential backoff, then the
// delivery is journaled as failed and never retried again.
export const INBOX_DELIVERY_RETRIES = 3;

const subscriptionIdOf = roomId => `approval-inbox:${roomId}`;

const roomOf = roomId => {
  check(typeof roomId === "string" && roomId.length > 0, "inbox_webhook_invalid",
    "roomId must be a non-empty string");
  return roomId;
};

const cardDataOf = (eventType, { cardId, card, actor }) => {
  check(typeof cardId === "string" && cardId.length > 0, "inbox_webhook_invalid",
    "cardId must be a non-empty string");
  check(card === undefined || (card !== null && typeof card === "object" && !Array.isArray(card)),
    "inbox_webhook_invalid", "card must be a plain object if given");
  check(actor === undefined || actor === null || (typeof actor === "object" && !Array.isArray(actor)),
    "inbox_webhook_invalid", "actor must be a plain object if given");
  return Object.freeze({ cardId, transition: eventType,
    card: Object.freeze({ ...(card ?? {}) }),
    actor: actor == null ? null : Object.freeze({ ...actor }) });
};

export function createApprovalInboxWebhooks({ store, journal, deliver = postDelivery,
  clock = () => Date.now(), id = () => randomUUID(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  check(store === undefined || store instanceof Map, "inbox_webhook_invalid", "store must be a Map if given");
  check(journal === undefined || Array.isArray(journal), "inbox_webhook_invalid", "journal must be an array if given");
  check(typeof deliver === "function", "inbox_webhook_invalid", "deliver must be a function");
  check(typeof clock === "function", "inbox_webhook_invalid", "clock must be a function");
  check(typeof id === "function", "inbox_webhook_invalid", "id must be a function");
  check(typeof sleep === "function", "inbox_webhook_invalid", "sleep must be a function");
  const registrations = store ?? new Map(); // roomId -> registration
  const outcomes = journal ?? [];

  // Opt a room in: validate the target once now (dispatch re-validates at
  // every attempt), require an HMAC signing secret, enable. Re-registering
  // a room updates its target — the opt-in is idempotent.
  const register = ({ roomId, url, secret }) => {
    roomOf(roomId);
    validateWebhookUrl(url); // throws WebhookError on http/private-host/etc.
    check(typeof secret === "string" && secret.length >= 16, "inbox_webhook_invalid",
      "secret must be a string of at least 16 chars");
    const registration = Object.freeze({ roomId, url, secret, enabled: true });
    registrations.set(roomId, registration);
    return registration;
  };

  const registrationOf = roomId => {
    roomOf(roomId);
    const registration = registrations.get(roomId);
    if (!registration) fail("inbox_webhook_unknown_room", `no webhook registration for room "${roomId}"`);
    return registration;
  };

  const unregister = roomId => {
    registrationOf(roomId);
    registrations.delete(roomId);
  };

  const setEnabled = (roomId, enabled) => {
    const registration = registrationOf(roomId);
    check(typeof enabled === "boolean", "inbox_webhook_invalid", "enabled must be a boolean");
    const updated = Object.freeze({ ...registration, enabled });
    registrations.set(roomId, updated);
    return updated;
  };

  // Default OFF: unknown or disabled rooms send nothing.
  const isEnabled = roomId => {
    if (typeof roomId !== "string" || roomId.length === 0) return false;
    return registrations.get(roomId)?.enabled === true;
  };

  const terminalOutcome = ({ registration, deliveryId, eventType, cardId, state, attempts, status, error }) =>
    Object.freeze({ deliveryId, roomId: registration.roomId, eventType, cardId,
      state, attempts, status, error, finishedAt: new Date(clock()).toISOString() });

  const runDelivery = async ({ registration, deliveryId, eventType, cardId, envelope, headers }) => {
    let attempts = 0;
    let lastError = "delivery failed";
    let lastStatus = 0;
    for (;;) {
      attempts += 1;
      let result;
      try {
        // postDelivery never throws for transport/HTTP failures, but a
        // custom deliver step might — either way the decision path survives.
        result = await deliver({ url: registration.url, envelope, headers, timeoutMs: INBOX_DELIVERY_TIMEOUT_MS });
      } catch (error) {
        result = { ok: false, status: 0, error: String(error?.message ?? error).slice(0, 500), classification: "retry" };
      }
      const status = Number.isInteger(result?.status) ? result.status : 0;
      if (result?.ok === true) {
        return terminalOutcome({ registration, deliveryId, eventType, cardId,
          state: "delivered", attempts, status, error: null });
      }
      lastError = typeof result?.error === "string" && result.error.length > 0
        ? result.error.slice(0, 500) : `HTTP ${status}`;
      lastStatus = status;
      if (result?.classification !== "retry" || attempts > INBOX_DELIVERY_RETRIES) {
        return terminalOutcome({ registration, deliveryId, eventType, cardId,
          state: "failed", attempts, status: lastStatus, error: lastError });
      }
      await sleep(backoffDelayMs(attempts - 1)); // 5s, 10s, 20s before retries 1, 2, 3
    }
  };

  // Fire a transition event. Validates synchronously; the delivery loop
  // runs detached — the caller never has to await it, so the decision
  // path is never blocked. Returns null when the room is not opted in
  // (default OFF). Otherwise returns { deliveryId, promise }; the promise
  // resolves to the journaled terminal outcome and never rejects for
  // transport/HTTP failures (only programmer errors throw, synchronously).
  const notify = (eventType, { roomId, cardId, card, actor } = {}) => {
    check(INBOX_WEBHOOK_EVENTS.includes(eventType), "inbox_webhook_invalid",
      `eventType must be one of ${INBOX_WEBHOOK_EVENTS.join(", ")}`);
    const registration = isEnabled(roomId) ? registrations.get(roomId) : null;
    if (!registration) return null;
    const data = cardDataOf(eventType, { cardId, card, actor });
    const issuedAt = clock();
    check(Number.isInteger(issuedAt) && issuedAt > 0, "inbox_webhook_invalid",
      "clock must return a positive integer timestamp");
    const deliveryId = id();
    check(typeof deliveryId === "string" && deliveryId.length > 0, "inbox_webhook_invalid",
      "id must return a non-empty string");
    const subscriptionId = subscriptionIdOf(roomId);
    const envelope = deliveryEnvelope({ deliveryId, subscriptionId, eventType, issuedAt, roomId, data });
    const signature = signDelivery(registration.secret, { deliveryId, eventType, issuedAt, data });
    const headers = deliveryHeaders({ deliveryId, subscriptionId, eventType, issuedAt, signature });
    const promise = runDelivery({ registration, deliveryId, eventType, cardId: data.cardId, envelope, headers })
      .then(outcome => { outcomes.push(outcome); return outcome; });
    return { deliveryId, promise };
  };

  return Object.freeze({ register, unregister, setEnabled, isEnabled, notify,
    size: () => registrations.size, events: INBOX_WEBHOOK_EVENTS });
}
