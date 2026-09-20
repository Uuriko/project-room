import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  classifyResponse,
  deliverPush,
  deliverToSubscriptions,
  encodePayload,
  normaliseSubscription,
  pushConfigured,
  pushPayloadFor,
  subscriptionExpired,
  vapidFromEnv
} from "../server/push-subscriptions.mjs";
import { decryptContent, fromBase64Url, generateVapidKeys, hkdfExpand, hkdfExtract, toBase64Url } from "../server/web-push.mjs";

// A real subscription's shape, with the RFC 8291 receiver key so a payload sent
// to it can actually be opened again in the last test.
const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RECEIVER_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

const subscription = (endpoint = "https://push.example.com/send/abc") => ({
  endpoint,
  keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET }
});

const reply = (status, headers = {}) => ({ status, headers: { get: name => headers[name.toLowerCase()] ?? null } });

// This module follows the repo's ServiceError shape: a machine-readable `code`
// and a separate sentence a member could actually be shown. Assert on the code,
// so rewording a message for a human never breaks a test.
const throwsCode = (fn, code, note) => {
  try { fn(); } catch (error) {
    assert.equal(error.code, code, note ?? `expected code ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(note ?? `expected ${code} to be thrown`);
};

test("a browser subscription is canonicalised, and the same endpoint twice is the same record", () => {
  const first = normaliseSubscription(subscription(), { now: 1000, memberId: "maya" });
  const second = normaliseSubscription({ ...subscription(), expirationTime: null }, { now: 2000, memberId: "maya" });

  assert.equal(first.id, second.id, "re-subscribing the same device must not create a second record");
  assert.equal(first.origin, "https://push.example.com");
  assert.equal(first.memberId, "maya");
  assert.equal(first.expirationTime, null);
  assert.equal(first.createdAt, 1000);
});

test("subscription material is refused at the edge, not at send time", () => {
  const cases = [
    [null, "push_subscription_invalid"],
    [{ keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET } }, "push_endpoint_required"],
    [{ endpoint: "http://push.example.com/x", keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET } }, "push_endpoint_not_https"],
    [{ endpoint: "nonsense", keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET } }, "push_endpoint_invalid"],
    [{ endpoint: "https://push.example.com/x" }, "push_keys_required"],
    [{ endpoint: "https://push.example.com/x", keys: { p256dh: "***", auth: AUTH_SECRET } }, "push_key_p256dh_invalid"],
    // A valid base64url string of the wrong length: the shape check has to be
    // on the decoded bytes, not on the text.
    [{ endpoint: "https://push.example.com/x", keys: { p256dh: toBase64Url(new Uint8Array(64)), auth: AUTH_SECRET } }, "push_key_p256dh_invalid"],
    [{ endpoint: "https://push.example.com/x", keys: { p256dh: RECEIVER_PUBLIC, auth: toBase64Url(new Uint8Array(8)) } }, "push_key_auth_invalid"],
    [{ endpoint: `https://push.example.com/${"x".repeat(3000)}`, keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET } }, "push_endpoint_too_long"]
  ];
  for (const [input, code] of cases) throwsCode(() => normaliseSubscription(input), code, `expected ${code} for ${JSON.stringify(input)?.slice(0, 60)}`);
});

test("an expired subscription is retired without a request being made", async () => {
  const expired = normaliseSubscription({ ...subscription(), expirationTime: 5000 }, { now: 1000 });
  assert.equal(subscriptionExpired(expired, 6000), true);
  assert.equal(subscriptionExpired(expired, 4000), false);

  let called = false;
  const result = await deliverPush({
    subscription: expired,
    payload: { v: 1 },
    fetchImpl: () => { called = true; throw new Error("should not be reached"); },
    now: 6000
  });
  assert.equal(result.outcome, "retired");
  assert.equal(result.reason, "subscription_expired");
  assert.equal(called, false, "an expired subscription must not cost a request");
});

// ---------------------------------------------------------------------------
// The payload must not carry room content.
// ---------------------------------------------------------------------------

test("a push payload carries counts and ids, never anything that was said", () => {
  const secret = "the acquisition price is 4.2 million";
  const payload = pushPayloadFor({
    roomId: "commons",
    unread: 3,
    sequence: 91,
    notifications: [
      { kind: "mention", messageId: "m1", sequence: 91, body: secret, actorDisplayName: "Maya Chen" },
      { kind: "mention", messageId: "m2", sequence: 90, body: secret },
      { kind: "work_update", workItemId: "w1", sequence: 88, title: "Ship the pricing page" }
    ]
  });

  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes(secret), "a message body must never reach a lock screen");
  assert.ok(!serialised.includes("Maya Chen"), "nor a display name");
  assert.ok(!serialised.includes("Ship the pricing page"), "nor a work item title");
  assert.ok(!serialised.includes("m1") && !serialised.includes("w1"), "nor the ids of what was said");

  assert.deepEqual(payload, { v: 1, roomId: "commons", unread: 3, counts: { mention: 2, work_update: 1 }, sequence: 91 });
});

test("the payload the real notification feed produces is also content-free", async t => {
  // Built from the actual read model rather than a hand-written item, so a
  // future field added to a notification item is caught here rather than
  // quietly riding out to a lock screen.
  const directory = mkdtempSync(join(tmpdir(), "room-push-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });

  send(T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya Chen", kind: "human", permissions: ["steer"] });
  const mayaKey = store.issueAccessKey("commons", "maya");
  const confidential = "board packet says we extend runway by cutting the SF office";
  send(T.MESSAGE_POSTED, { messageId: "m-secret", body: `@Maya Chen ${confidential}` });

  const feed = store.notifications.list(mayaKey, "commons", null, {});
  assert.ok(feed.unread >= 1, "the fixture should produce at least one notification");

  const payload = pushPayloadFor(feed);
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes(confidential), "no body text");
  assert.ok(!serialised.includes("Maya Chen"), "no display name");
  assert.ok(!serialised.includes("m-secret"), "no message id");
  assert.equal(payload.roomId, "commons");
  assert.equal(payload.unread, feed.unread);
  assert.equal(payload.sequence, feed.sequence);
});

test("an oversized payload is refused before it is encrypted", () => {
  throwsCode(() => encodePayload({ v: 1, roomId: "c", filler: "x".repeat(5000) }), "push_payload_too_large");
  assert.ok(encodePayload({ v: 1, roomId: "commons", unread: 2, counts: {}, sequence: 1 }).length < 200);
  throwsCode(() => pushPayloadFor({ unread: 1 }), "push_payload_room_required");
});

// ---------------------------------------------------------------------------
// Response handling: what is permanent and what is not.
// ---------------------------------------------------------------------------

test("push service responses are classified permanent or temporary", () => {
  assert.equal(classifyResponse({ status: 201 }).outcome, "delivered");
  assert.equal(classifyResponse({ status: 200 }).outcome, "delivered");
  // The only two statuses that may delete a member's subscription.
  assert.equal(classifyResponse({ status: 404 }).outcome, "retired");
  assert.equal(classifyResponse({ status: 410 }).outcome, "retired");
  // A bad hour at the push service must never cost a subscription.
  assert.equal(classifyResponse({ status: 429 }).outcome, "retry");
  assert.equal(classifyResponse({ status: 500 }).outcome, "retry");
  assert.equal(classifyResponse({ status: 503 }).outcome, "retry");
  assert.equal(classifyResponse({ status: 413 }).outcome, "failed");
  assert.equal(classifyResponse({ status: 401 }).reason, "vapid_rejected");
  assert.equal(classifyResponse({ status: 403 }).reason, "vapid_rejected");
  assert.equal(classifyResponse({ status: 400 }).outcome, "failed");
});

test("a timeout or an unreachable service is a retry, not a lost subscription", async () => {
  const timedOut = await deliverPush({
    subscription: normaliseSubscription(subscription()),
    payload: { v: 1, roomId: "commons" },
    fetchImpl: () => { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; }
  });
  assert.equal(timedOut.outcome, "retry");
  assert.equal(timedOut.reason, "push_service_timeout");

  const unreachable = await deliverPush({
    subscription: normaliseSubscription(subscription()),
    payload: { v: 1, roomId: "commons" },
    fetchImpl: () => { throw new Error("ECONNREFUSED"); }
  });
  assert.equal(unreachable.outcome, "retry");
  assert.equal(unreachable.reason, "push_service_unreachable");
});

test("a send is bounded by a timeout rather than hanging the run", async () => {
  let seenSignal = null;
  await deliverPush({
    subscription: normaliseSubscription(subscription()),
    payload: { v: 1, roomId: "commons" },
    timeoutMs: 25,
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      seenSignal = init.signal;
      // A real timer, deliberately. AbortSignal.timeout() schedules an unref'd
      // timer, so a pending promise waiting only on its abort event does not by
      // itself keep the event loop alive - node exits and the test is reported
      // as cancelled rather than failed. The slow "response" holds the loop open
      // until the abort arrives and clears it.
      const slowResponse = setTimeout(() => resolve(reply(201)), 5000);
      init.signal.addEventListener("abort", () => { clearTimeout(slowResponse); reject(init.signal.reason); }, { once: true });
    })
  });
  assert.ok(seenSignal instanceof AbortSignal, "every request must carry an abort signal");
  assert.equal(seenSignal.aborted, true, "and the signal must actually fire");
});

test("Retry-After is carried through in both of its formats", async () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const seconds = await deliverPush({
    subscription: normaliseSubscription(subscription()), payload: { v: 1, roomId: "c" }, now,
    fetchImpl: async () => reply(429, { "retry-after": "120" })
  });
  assert.equal(seconds.retryAfter, now + 120000);

  const httpDate = await deliverPush({
    subscription: normaliseSubscription(subscription()), payload: { v: 1, roomId: "c" }, now,
    fetchImpl: async () => reply(503, { "retry-after": "Thu, 17 Sep 2026 12:05:00 GMT" })
  });
  assert.equal(httpDate.retryAfter, Date.UTC(2026, 8, 17, 12, 5, 0));

  const absent = await deliverPush({
    subscription: normaliseSubscription(subscription()), payload: { v: 1, roomId: "c" }, now,
    fetchImpl: async () => reply(429)
  });
  assert.equal(absent.retryAfter, null);
});

test("a fan-out reports every device and names exactly the dead ones", async () => {
  const phone = normaliseSubscription(subscription("https://push.example.com/send/phone"));
  const laptop = normaliseSubscription(subscription("https://push.example.com/send/laptop"));
  const stale = normaliseSubscription(subscription("https://push.example.com/send/stale"));
  const flaky = normaliseSubscription(subscription("https://push.example.com/send/flaky"));

  const result = await deliverToSubscriptions({
    subscriptions: [phone, laptop, stale, flaky],
    payload: { v: 1, roomId: "commons", unread: 1 },
    fetchImpl: async url => {
      if (url.endsWith("/stale")) return reply(410);
      if (url.endsWith("/flaky")) return reply(503);
      return reply(201);
    }
  });

  assert.deepEqual(result.tally, { delivered: 2, retired: 1, retry: 1, failed: 0 });
  assert.deepEqual(result.retire, ["https://push.example.com/send/stale"], "only the gone endpoint is retired");
  assert.equal(result.results.length, 4, "every device is accounted for");
});

test("one broken send does not lose the others", async () => {
  const good = normaliseSubscription(subscription("https://push.example.com/send/good"));
  const broken = { endpoint: "https://push.example.com/send/broken" }; // no keys: encryption will throw

  const result = await deliverToSubscriptions({
    subscriptions: [good, broken],
    payload: { v: 1, roomId: "commons" },
    fetchImpl: async () => reply(201)
  });

  assert.equal(result.tally.delivered, 1, "the healthy device still got its push");
  assert.equal(result.tally.failed, 1);
  assert.equal(result.results.find(r => r.outcome === "failed").reason, "push_send_error");
});

// ---------------------------------------------------------------------------
// Shipping dark, and end to end.
// ---------------------------------------------------------------------------

test("with no VAPID keys configured the feature is simply off", () => {
  assert.equal(pushConfigured({}), false);
  assert.equal(pushConfigured({ ROOM_VAPID_PUBLIC_KEY: "a", ROOM_VAPID_PRIVATE_KEY: "b" }), false, "all three are required");
  assert.equal(vapidFromEnv({}), null);

  const env = { ROOM_VAPID_PUBLIC_KEY: "pub", ROOM_VAPID_PRIVATE_KEY: "priv", ROOM_VAPID_SUBJECT: "mailto:ops@example.com" };
  assert.equal(pushConfigured(env), true);
  assert.deepEqual(vapidFromEnv(env), { publicKey: "pub", privateKey: "priv", subject: "mailto:ops@example.com" });
});

test("end to end: what the push service receives is what the browser can open", async () => {
  // The strongest check available without a real browser. We send through the
  // full path, capture the bytes a push service would store, then derive the
  // receiver's key the way a user agent does and decrypt them.
  const keys = await generateVapidKeys();
  let captured = null;

  const result = await deliverPush({
    subscription: normaliseSubscription(subscription()),
    payload: pushPayloadFor({ roomId: "commons", unread: 2, sequence: 44, notifications: [{ kind: "mention" }, { kind: "reply" }] }),
    vapid: { subject: "mailto:ops@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey },
    fetchImpl: async (url, init) => { captured = { url, init }; return reply(201); }
  });

  assert.equal(result.outcome, "delivered");
  assert.equal(captured.init.headers["Content-Encoding"], "aes128gcm");
  assert.match(captured.init.headers.Authorization, /^vapid t=/);

  // Now be the browser. RFC 8291: the receiver runs the same derivation with
  // its own private key against the sender key carried in the header's keyid.
  const body = captured.init.body;
  const senderPublic = body.subarray(21, 21 + 65);
  const receiverPublic = fromBase64Url(RECEIVER_PUBLIC);

  const receiverPrivate = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", d: RECEIVER_PRIVATE,
      x: toBase64Url(receiverPublic.subarray(1, 33)), y: toBase64Url(receiverPublic.subarray(33, 65)), ext: true
    },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]
  );
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, receiverPrivate, 256));

  const prkKey = await hkdfExtract(fromBase64Url(AUTH_SECRET), shared);
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...receiverPublic, ...senderPublic]);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const opened = await decryptContent({ body, inputKeyMaterial: ikm });
  const received = JSON.parse(new TextDecoder().decode(opened.plaintext));

  assert.deepEqual(received, { v: 1, roomId: "commons", unread: 2, counts: { mention: 1, reply: 1 }, sequence: 44 },
    "the receiver reads back exactly the payload that was sent");
});
