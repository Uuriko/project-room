import { HUMAN_PUSH_ROUTES } from "../server/routes/human-push.mjs";
// Wave-2 #1601: human push preferences a human can actually control.
// The push channel delivers exactly two event kinds (mention, dm); the
// preferences switch each kind on or off, default on (today's behavior),
// enforced by HumanPush.notifyPosted before any send.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateVapidKeys } from "../server/web-push.mjs";

// RFC 8291 receiver key, same public test vector as tests/human-push.test.js.
const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "tBHItJI5svbpez7KI4CCXg";

const browserSub = endpoint => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET }
});

const reply = status => ({ status, headers: { get: () => null } });

async function boot(t, { push = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-push-prefs-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const calls = [];
  store.humanPush.configure({
    fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(201); }
  });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  const add = (memberId, displayName, kind) => send(ownerKey, T.MEMBER_ADDED, {
    memberId, displayName, kind, permissions: ["steer", "accept_work", "complete_work", "verify"]
  });
  add("maya", "Maya", "human");
  add("sam", "Sam", "human");
  add("agent", "Test agent", "agent");
  const mayaKey = store.issueAccessKey("commons", "maya");
  const samKey = store.issueAccessKey("commons", "sam");
  const agentKey = store.issueAccessKey("commons", "agent");
  const keys = push ? await generateVapidKeys() : null;
  const vapid = keys ? { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:push@example.com" } : null;
  const server = createRoomServer({ store, push: vapid });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const json = async (path, options) => {
    const response = await request(path, options);
    return { status: response.status, body: await response.json() };
  };
  return { store, send, request, json, calls, ownerKey, mayaKey, samKey, agentKey };
}

test("GET /human-push reports push preferences, defaulting to on", async t => {
  const { json, mayaKey } = await boot(t);
  const { status, body } = await json("/api/rooms/commons/human-push", { token: mayaKey });
  assert.equal(status, 200);
  assert.deepEqual(body.preferences, { mention: true, dm: true, preview: false, quietHours: null });
});

test("PATCH /human-push sets preferences, merges partial updates, and validates", async t => {
  const { json, mayaKey, agentKey, store } = await boot(t);

  const anonymous = await json("/api/rooms/commons/human-push", {
    method: "PATCH", data: { preferences: { mention: false } }
  });
  assert.equal(anonymous.status, 401);

  const agent = await json("/api/rooms/commons/human-push", {
    method: "PATCH", token: agentKey, data: { preferences: { mention: false } }
  });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error.code, "human_push_humans_only");

  const off = await json("/api/rooms/commons/human-push", {
    method: "PATCH", token: mayaKey, data: { preferences: { mention: false } }
  });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.preferences, { mention: false, dm: true, preview: false, quietHours: null });

  const merge = await json("/api/rooms/commons/human-push", {
    method: "PATCH", token: mayaKey, data: { preferences: { dm: false } }
  });
  assert.equal(merge.status, 200);
  assert.deepEqual(merge.body.preferences, { mention: false, dm: false, preview: false, quietHours: null });

  const back = await json("/api/rooms/commons/human-push", {
    method: "PATCH", token: mayaKey, data: { preferences: { mention: true } }
  });
  assert.deepEqual(back.body.preferences, { mention: true, dm: false, preview: false, quietHours: null });

  const persisted = await json("/api/rooms/commons/human-push", { token: mayaKey });
  assert.deepEqual(persisted.body.preferences, { mention: true, dm: false, preview: false, quietHours: null });

  for (const bad of [
    {},
    { preferences: null },
    { preferences: "off" },
    { preferences: {} },
    { preferences: { mention: "no" } },
    { preferences: { dm: 0 } },
    { preferences: { mention: false, work: false } },
    { mention: false }
  ]) {
    const refused = await json("/api/rooms/commons/human-push", { method: "PATCH", token: mayaKey, data: bad });
    assert.equal(refused.status, 422, JSON.stringify(bad));
    assert.equal(refused.body.error.code, "invalid_human_push_preferences", JSON.stringify(bad));
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM human_push_preferences").get().n, 1);
});

test("preferences are stored even when push is not configured", async t => {
  const { json, mayaKey } = await boot(t, { push: false });
  const saved = await json("/api/rooms/commons/human-push", {
    method: "PATCH", token: mayaKey, data: { preferences: { dm: false } }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.preferences, { mention: true, dm: false, preview: false, quietHours: null });
  assert.equal(saved.body.configured, false);
});

test("notifyPosted honors the per-kind switches, on by default", async t => {
  const { store, send, calls, ownerKey, mayaKey, samKey } = await boot(t);
  store.humanPush.save(mayaKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/maya"));
  store.humanPush.save(samKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/sam"));

  // Defaults: both kinds push.
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Maya hello" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  calls.length = 0;

  // Maya turns mentions off: mentions stop, DMs still reach her.
  store.humanPush.setPreferences(mayaKey, "commons", { preferences: { mention: false } });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m2", body: "@Maya quiet please" });
  await store.humanPush.flush();
  assert.equal(calls.length, 0);
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m3", body: "private", toMemberId: "maya" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://fcm.googleapis.com/fcm/send/maya");
  calls.length = 0;

  // Maya turns DMs off too: nothing reaches her. Sam is unaffected.
  store.humanPush.setPreferences(mayaKey, "commons", { preferences: { dm: false } });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m4", body: "private again", toMemberId: "maya" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m5", body: "@Sam hi" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://fcm.googleapis.com/fcm/send/sam");
  calls.length = 0;

  // Turning mentions back on restores them without touching the DM switch.
  store.humanPush.setPreferences(mayaKey, "commons", { preferences: { mention: true } });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m6", body: "@Maya welcome back" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m7", body: "still private", toMemberId: "maya" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://fcm.googleapis.com/fcm/send/maya");
});

test("the older in-app preference levels still do not steer the push", async t => {
  const { store, send, calls, ownerKey, mayaKey } = await boot(t);
  store.humanPush.save(mayaKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/maya"));
  send(mayaKey, T.NOTIFICATION_PREFERENCES_SET, { preferences: { mentions: "none" } });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "still", body: "@Maya please still ping" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1, "only the new push switches gate the push channel");
});

// Unreadable preference evidence must not re-enable an opted-out delivery.
test("unreadable push preferences suppress delivery", async t => {
 const {store,send,calls,ownerKey,mayaKey}=await boot(t);
 store.humanPush.save(mayaKey,"commons",browserSub("https://fcm.googleapis.com/fcm/send/maya"));
 store.humanPush.setPreferences(mayaKey,"commons",{preferences:{mention:false}});
 store.db.exec("ALTER TABLE human_push_preferences RENAME TO unavailable_push_preferences");
 send(ownerKey,T.MESSAGE_POSTED,{messageId:"unreadable-prefs",body:"@Maya do not notify"});
 await store.humanPush.flush();
 assert.equal(calls.length,0);
});

test("push route metadata keeps every preference and subscription operation room-authenticated", () => {
 assert.deepEqual(HUMAN_PUSH_ROUTES.map(r=>[r.method,r.auth,r.scope]),[["GET","room","room"],["POST","room","room"],["PATCH","room","room"],["DELETE","room","room"]]);
});

// Quiet hours are enforced at send time, not just at post time. The push
// path authorizes synchronously inside the message transaction and delivers
// asynchronously; a quiet-hours window that starts in between must still
// silence the channel — the member asked for silence, and the send-time
// re-check (stillVisible) is where the latest preference state is honored.
test("quiet hours starting between post and delivery suppress the push", async t => {
  const { store, send, calls, ownerKey, mayaKey } = await boot(t);
  store.humanPush.save(mayaKey, "commons", browserSub("https://fcm.googleapis.com/fcm/send/maya"));
  store.humanPush.setPreferences(mayaKey, "commons", {
    preferences: { quietHours: { start: "22:00", end: "07:00", tz: "UTC" } }
  });
  const at = Date.UTC(2026, 9, 7, 21, 59, 0); // 21:59 UTC: outside quiet hours
  const realNow = store.now.bind(store);
  store.now = () => at;
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-quiet-race", body: "@Maya hello" });
  store.now = () => at + 2 * 60 * 1000; // 22:01 UTC: inside quiet hours
  await store.humanPush.flush();
  assert.equal(calls.length, 0, "a push must not fire after quiet hours start");
  store.now = realNow;
});
