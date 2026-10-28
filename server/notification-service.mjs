// notification-service.mjs — notification plumbing with idempotency keys
// (DISCOVERY-50 lane H5, charter H5-notification-idempotency).
//
// Shape: queue intake -> provider abstraction -> sink, with a
// per-notification idempotency key derived from the notification's
// identity (kind + identity fields), exponential backoff with a bounded
// attempt budget (default 5 attempts, base delay 20 ms x2 — the lane's
// measured shape), and a counted dead-letter surface: a notification
// whose budget exhausts is recorded and countable, never silently
// dropped.
//
// Delivered property is EFFECTIVELY-ONCE (at-least-once transport +
// idempotent delivery). Nothing here claims exactly-once.
//
// The provider is injected: { send(notification) -> Promise }. Tests use
// a fake provider/sink; this module performs NO external sends itself.
// The real mail transport candidate is nodemailer (its transport
// interface shape matches the provider abstraction); licence check:
// nodemailer is MIT-licensed (verified against its package licence
// field during this build) — the wiring of a live transport is a
// deployment act, not part of this module.
//
// Wired shapes (the three that already exist): deploy alarm, mention
// wake, digest — see notificationShapes below. Each builder derives the
// idempotency key from the shape's identity, so a resubmission of the
// same notification collides on the key and is absorbed.

import { createHash } from "node:crypto";

export const NOTIFICATION_SERVICE_VERSION = "1.0";

function deriveKey(kind, identity) {
  return createHash("sha256").update(`${kind}|${identity}`).digest("hex").slice(0, 32);
}

export const notificationShapes = {
  deployAlarm({ deploymentId, summary }) {
    return { kind: "deploy-alarm", to: "ops", body: String(summary ?? ""),
      idempotencyKey: deriveKey("deploy-alarm", String(deploymentId)) };
  },
  mentionWake({ roomId, sequence, mentionId }) {
    return { kind: "mention-wake", to: "agent", body: `@you mentioned in ${roomId} at seq ${sequence}`,
      idempotencyKey: deriveKey("mention-wake", `${roomId}:${sequence}:${mentionId}`) };
  },
  digest({ date, recipientId }) {
    return { kind: "digest", to: String(recipientId), body: `daily digest ${date}`,
      idempotencyKey: deriveKey("digest", `${recipientId}:${date}`) };
  },
};

export function createNotificationService({
  provider,
  maxAttempts = 5,
  baseDelayMs = 20,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!provider || typeof provider.send !== "function") {
    throw new TypeError("createNotificationService: provider with send() is required");
  }
  const deliveredKeys = new Set();
  const inFlight = new Map();
  const dead = [];
  let deliveredCount = 0;

  async function deliver(notification, key) {
    let delay = baseDelayMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await provider.send(notification);
        deliveredKeys.add(key);
        deliveredCount++;
        return { status: "delivered", idempotencyKey: key, attempts: attempt };
      } catch {
        if (attempt < maxAttempts) { await sleep(delay); delay *= 2; }
      }
    }
    dead.push({ notification, idempotencyKey: key, attempts: maxAttempts });
    return { status: "dead-lettered", idempotencyKey: key, attempts: maxAttempts };
  }

  async function submit(notification) {
    const key = notification?.idempotencyKey;
    if (!key) throw new TypeError("notification.idempotencyKey is required (derive it from the notification identity)");
    if (deliveredKeys.has(key)) return { status: "duplicate-absorbed", idempotencyKey: key };
    // Concurrent resubmission of the same key joins the in-flight
    // delivery instead of sending again — the key, not the call,
    // identifies the notification.
    if (inFlight.has(key)) return inFlight.get(key);
    const run = deliver(notification, key);
    inFlight.set(key, run);
    try { return await run; } finally { inFlight.delete(key); }
  }

  return {
    submit,
    deadLetters: () => dead.slice(),
    counts: () => ({ delivered: deliveredCount, deadLettered: dead.length }),
  };
}
