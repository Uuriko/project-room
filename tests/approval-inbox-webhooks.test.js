// Fail-first tests for the approval-inbox outbound webhooks
// (server/approval-inbox-webhooks.mjs, WAVE-500 guild 10 slice 27/50):
// opt-in, signed delivery of approval.card.{opened,decided,expired}
// transitions. Fire-and-forget: a delivery failure must never block the
// decision path.
//
// Authoring-gate answers: (1) the observable contract is opt-in
// room-level delivery of card transitions over the repo's signed webhook
// wire format, with bounded retries and a terminal journal entry; (2) the
// credible regressions are surprise outbound traffic from a default-on
// flag, unsigned deliveries, an unbounded retry hammer, a throwing
// transport crashing the decide path, SSRF-able registration URLs, and a
// permanent rejection retried forever; (3) nothing covers this —
// server/webhook-dispatch.mjs tests own the wire primitives (signing,
// headers, classification), these own the opt-in/notify/retry/journal
// orchestration; (4) deliver/sleep/clock/id are the module's documented
// injection points (same pattern as postDelivery's fetchImpl); the sleep
// seam is the only way to test the backoff contract without 35s of wall
// clock.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createApprovalInboxWebhooks,
  INBOX_WEBHOOK_EVENTS,
  INBOX_DELIVERY_TIMEOUT_MS,
  INBOX_DELIVERY_RETRIES,
  ApprovalInboxWebhookError,
} from "../server/approval-inbox-webhooks.mjs";
import { verifyDeliverySignature } from "../server/webhook-dispatch.mjs";

const ROOM = "room_abc";
const URL = "https://hooks.example.test/inbox";
const SECRET = "inbox-signing-secret-0123456789abcdef";
const NOW = 1_700_000_000_000;

const harness = ({ deliver, sleep } = {}) => {
  const calls = [];
  const sleepDelays = [];
  const journal = [];
  let n = 0;
  const inbox = createApprovalInboxWebhooks({
    journal,
    clock: () => NOW,
    id: () => `del_${++n}`,
    sleep: sleep ?? (async ms => { sleepDelays.push(ms); }),
    deliver: deliver ?? (async args => { calls.push(args); return { ok: true, status: 200, error: null }; }),
  });
  return { inbox, journal, calls, sleepDelays };
};
const registered = (opts) => {
  const h = harness(opts);
  h.inbox.register({ roomId: ROOM, url: URL, secret: SECRET });
  return h;
};
const notifyOpened = (inbox, extra = {}) =>
  inbox.notify("approval.card.opened", { roomId: ROOM, cardId: "card_1",
    card: { title: "Approve $50 bounty payout" }, actor: { id: "human_1", kind: "human" }, ...extra });

test("the supported transition events are approval.card.opened/decided/expired", () => {
  assert.deepEqual([...INBOX_WEBHOOK_EVENTS],
    ["approval.card.opened", "approval.card.decided", "approval.card.expired"]);
});

test("notify is a no-op for rooms that never opted in (default OFF)", async () => {
  const { inbox, journal, calls } = harness();
  const result = inbox.notify("approval.card.opened", { roomId: "room_never_registered", cardId: "card_1" });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
  assert.equal(journal.length, 0);
});

test("a disabled registration sends nothing (opt-out honored)", async () => {
  const { inbox, journal, calls } = registered();
  inbox.setEnabled(ROOM, false);
  assert.equal(inbox.isEnabled(ROOM), false);
  const result = notifyOpened(inbox);
  assert.equal(result, null);
  assert.equal(calls.length, 0);
  assert.equal(journal.length, 0);
});

test("registration validates the URL with the repo webhook validator and requires a strong secret", () => {
  const { inbox } = harness();
  assert.throws(() => inbox.register({ roomId: ROOM, url: "http://hooks.example.test/plain", secret: SECRET }),
    /https/);
  assert.throws(() => inbox.register({ roomId: ROOM, url: "https://localhost/loop", secret: SECRET }),
    /localhost|private or reserved/);
  assert.throws(() => inbox.register({ roomId: ROOM, url: URL, secret: "short" }),
    ApprovalInboxWebhookError);
  assert.throws(() => inbox.register({ roomId: "", url: URL, secret: SECRET }),
    ApprovalInboxWebhookError);
});

test("an opened transition delivers a signed POST with the 5s timeout", async () => {
  const { inbox, journal, calls } = registered();
  const { deliveryId, promise } = notifyOpened(inbox);
  assert.equal(deliveryId, "del_1");
  const outcome = await promise;
  assert.equal(outcome.state, "delivered");
  assert.equal(outcome.attempts, 1);
  assert.equal(calls.length, 1);
  const { url, envelope, headers, timeoutMs } = calls[0];
  assert.equal(url, URL);
  assert.equal(timeoutMs, INBOX_DELIVERY_TIMEOUT_MS);
  assert.equal(INBOX_DELIVERY_TIMEOUT_MS, 5 * 1000);
  assert.equal(envelope.eventType, "approval.card.opened");
  assert.equal(envelope.roomId, ROOM);
  assert.equal(envelope.data.cardId, "card_1");
  assert.equal(envelope.data.transition, "approval.card.opened");
  assert.equal(envelope.data.card.title, "Approve $50 bounty payout");
  assert.match(headers["x-webhook-signature"], /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyDeliverySignature(SECRET, headers["x-webhook-signature"], {
    deliveryId: envelope.deliveryId,
    eventType: "approval.card.opened",
    issuedAt: Date.parse(envelope.issuedAt),
    data: envelope.data,
  }), true);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].state, "delivered");
});

test("retryable failures retry 3x with backoff, then journal a failed outcome", async () => {
  const { inbox, journal, calls, sleepDelays } = registered({
    deliver: async args => { calls.push(args); return { ok: false, status: 503, error: "HTTP 503", classification: "retry" }; },
  });
  const { promise } = notifyOpened(inbox);
  const outcome = await promise;
  assert.equal(INBOX_DELIVERY_RETRIES, 3);
  assert.equal(calls.length, 1 + INBOX_DELIVERY_RETRIES); // 1 initial + 3 retries
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.attempts, 4);
  assert.match(outcome.error, /503/);
  assert.deepEqual(sleepDelays, [5000, 10000, 20000]); // exponential backoff between retries
  assert.equal(journal.length, 1);
  assert.equal(journal[0].state, "failed");
  assert.equal(journal[0].attempts, 4);
  assert.equal(Object.isFrozen(journal[0]), true);
});

test("a permanent rejection is journaled failed without retries", async () => {
  const { inbox, journal, calls } = registered({
    deliver: async args => { calls.push(args); return { ok: false, status: 400, error: "HTTP 400", classification: "dead" }; },
  });
  const outcome = await notifyOpened(inbox).promise;
  assert.equal(calls.length, 1);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.attempts, 1);
  assert.equal(journal.length, 1);
});

test("a throwing transport never blocks the decision path", async () => {
  const { inbox, journal, calls } = registered({
    deliver: () => { throw new Error("socket hangup"); },
  });
  // notify() returns synchronously — the decision path does not await delivery.
  const result = notifyOpened(inbox);
  assert.notEqual(result, null);
  assert.equal(typeof result.deliveryId, "string");
  let settled = false;
  const outcomePromise = result.promise.then(outcome => { settled = true; return outcome; });
  assert.equal(settled, false);
  const outcome = await outcomePromise;
  assert.equal(settled, true);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.attempts, 1 + INBOX_DELIVERY_RETRIES);
  assert.match(outcome.error, /socket hangup/);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].state, "failed");
});

test("unknown event types are rejected, not silently dropped", () => {
  const { inbox } = registered();
  assert.throws(() => inbox.notify("approval.card.bogus", { roomId: ROOM, cardId: "card_1" }),
    ApprovalInboxWebhookError);
});

test("re-registering a room updates the target (idempotent opt-in)", async () => {
  const { inbox, calls } = registered();
  const URL2 = "https://hooks.example.test/inbox-v2";
  inbox.register({ roomId: ROOM, url: URL2, secret: SECRET });
  const outcome = await notifyOpened(inbox).promise;
  assert.equal(outcome.state, "delivered");
  assert.equal(calls[0].url, URL2);
});

test("unregistering a room stops all delivery (default OFF again)", async () => {
  const { inbox, journal, calls } = registered();
  inbox.unregister(ROOM);
  assert.equal(inbox.isEnabled(ROOM), false);
  assert.equal(notifyOpened(inbox), null);
  assert.equal(calls.length, 0);
  assert.equal(journal.length, 0);
});
