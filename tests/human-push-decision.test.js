// Charter B-3 step 3: the `decision` push class (E63). Before it, human
// push carried mention|dm only, so a decision ask reached its decider
// only when they opened the room. Pins: the class delivers counts-only
// payloads to subscribed humans, honors its own preference switch
// (default on), never pushes agents or non-members, and fires from the
// access-request filing path to the owner/manage_members audience.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { HUMAN_PUSH_PREF_KINDS } from "../server/human-push.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { notificationFromPush } from "../src/human-push-display.js";
import { decryptContent, fromBase64Url, generateVapidKeys, hkdfExpand, hkdfExtract, toBase64Url } from "../server/web-push.mjs";

const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RECEIVER_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const browserSub = endpoint => ({ endpoint, expirationTime: null, keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET } });

async function openPush(captured) {
  const body = captured.init.body;
  const senderPublic = body.subarray(21, 21 + 65);
  const receiverPublic = fromBase64Url(RECEIVER_PUBLIC);
  const receiverPrivate = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: RECEIVER_PRIVATE,
    x: toBase64Url(receiverPublic.subarray(1, 33)), y: toBase64Url(receiverPublic.subarray(33, 65)), ext: true
  }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, receiverPrivate, 256));
  const prkKey = await hkdfExtract(fromBase64Url(AUTH_SECRET), shared);
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...receiverPublic, ...senderPublic]);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);
  const opened = await decryptContent({ body, inputKeyMaterial: ikm });
  return JSON.parse(new TextDecoder().decode(opened.plaintext));
}

async function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-push-decision-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const calls = [];
  const keys = await generateVapidKeys();
  store.humanPush.configure({
    vapid: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:push@example.com" },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 201, headers: { get: () => null } }; }
  });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["manage_members"] });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "agent", displayName: "Agent", kind: "agent", permissions: [] });
  const mayaKey = store.issueAccessKey("commons", "maya");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, calls, ownerKey, mayaKey };
}

test("decision is a first-class push preference kind, on by default", async t => {
  assert.deepEqual([...HUMAN_PUSH_PREF_KINDS], ["mention", "dm", "decision"]);
  const { store, mayaKey } = await boot(t);
  const before = store.humanPush.status(mayaKey, "commons");
  assert.equal(before.preferences.decision, true);
  assert.equal(before.preferences.mention, true);
  const off = store.humanPush.setPreferences(mayaKey, "commons", { preferences: { decision: false } });
  assert.equal(off.preferences.decision, false);
  assert.equal(off.preferences.mention, true, "partial merge leaves the other kinds alone");
  const back = store.humanPush.preferences(mayaKey, "commons");
  assert.equal(back.preferences.decision, false, "the switch persists");
  assert.throws(() => store.humanPush.setPreferences(mayaKey, "commons", { preferences: { decision: "yes" } }),
    { code: "invalid_human_push_preferences" });
});

test("notifyDecision delivers a counts-only decision payload and honors the switch", async t => {
  const { store, calls, mayaKey } = await boot(t);
  store.humanPush.save(mayaKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/maya"));
  const state = store.room("commons").state;
  const started = store.humanPush.notifyDecision({ roomId: "commons", state, memberId: "maya", count: 2 });
  assert.equal(started.sent, 1);
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  const opened = await openPush(calls[0]);
  assert.equal(opened.counts.decision, 2);
  assert.equal(opened.unread, 2);
  assert.equal(JSON.stringify(opened).includes("Maya"), false, "no names on a decision push");

  // The lock-screen rendering names the class, not a mention.
  const note = notificationFromPush(opened);
  assert.equal(note.title, "Decisions needed");
  assert.equal(note.body, "2 waiting in the room");
  const one = notificationFromPush({ v: 1, roomId: "commons", unread: 1, counts: { decision: 1 } });
  assert.equal(one.title, "Decision needed");
  const mixed = notificationFromPush({ v: 1, roomId: "commons", unread: 2, counts: { mention: 1, decision: 1 } });
  assert.equal(mixed.title, "Mentions and Decisions needed");

  calls.length = 0;
  store.humanPush.setPreferences(mayaKey, "commons", { preferences: { decision: false } });
  const suppressed = store.humanPush.notifyDecision({ roomId: "commons", state: store.room("commons").state, memberId: "maya", count: 1 });
  assert.equal(suppressed.sent, 0);
  await store.humanPush.flush();
  assert.equal(calls.length, 0, "decision switch off means no decision push");
});

test("notifyDecision never pushes agents, strangers, or unsubscribed humans", async t => {
  const { store, calls, ownerKey } = await boot(t);
  const state = store.room("commons").state;
  assert.equal(store.humanPush.notifyDecision({ roomId: "commons", state, memberId: "agent" }).sent, 0);
  assert.equal(store.humanPush.notifyDecision({ roomId: "commons", state, memberId: "ghost" }).sent, 0);
  assert.equal(store.humanPush.notifyDecision({ roomId: "commons", state, memberId: "owner" }).sent, 0,
    "the owner has no subscription in this fixture");
  void ownerKey;
  await store.humanPush.flush();
  assert.equal(calls.length, 0);
});

test("filing an access request pushes the deciders (owner + manage_members), counts only", async t => {
  const { store, calls, ownerKey, mayaKey } = await boot(t);
  store.db.exec(accessRequestSchema);
  store.humanPush.save(ownerKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/owner"));
  store.humanPush.save(mayaKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/maya"));
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 100 }) });
  store.db.prepare(`INSERT INTO access_requests
    (request_id, room_id, identity_id, display_name, requested_permissions, status, created_at)
    VALUES ('ar_push1','commons','some-identity','Hopeful','[]','pending',?)`).run(Date.now());
  accessRequests.emitAccessRequested("commons", {
    requestId: "ar_push1", identityId: "some-identity", displayName: "Hopeful",
    requestedPermissions: [], note: null, at: Date.now()
  });
  await store.humanPush.flush();
  const urls = calls.map(call => call.url).sort();
  assert.deepEqual(urls, ["https://fcm.googleapis.com/fcm/send/maya", "https://fcm.googleapis.com/fcm/send/owner"]);
  const opened = await openPush(calls[0]);
  assert.equal(opened.counts.decision, 1);
  assert.equal(JSON.stringify(opened).includes("Hopeful"), false, "the requester's name never reaches the lock screen");
});
