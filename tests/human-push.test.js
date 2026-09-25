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
import { decryptContent, fromBase64Url, generateVapidKeys, hkdfExpand, hkdfExtract, toBase64Url } from "../server/web-push.mjs";

// RFC 8291 receiver key, same public test vector as tests/push-subscriptions.test.js.
const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RECEIVER_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const SECRET = "the seahorse password is coral-99";

const browserSub = endpoint => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET }
});

const reply = status => ({ status, headers: { get: () => null } });

async function openPush(captured) {
  const body = captured.init.body;
  const senderPublic = body.subarray(21, 21 + 65);
  const receiverPublic = fromBase64Url(RECEIVER_PUBLIC);
  const receiverPrivate = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: RECEIVER_PRIVATE,
    x: toBase64Url(receiverPublic.subarray(1, 33)),
    y: toBase64Url(receiverPublic.subarray(33, 65)),
    ext: true
  }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, receiverPrivate, 256));
  const prkKey = await hkdfExtract(fromBase64Url(AUTH_SECRET), shared);
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...receiverPublic, ...senderPublic]);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);
  const opened = await decryptContent({ body, inputKeyMaterial: ikm });
  return JSON.parse(new TextDecoder().decode(opened.plaintext));
}

async function boot(t, { push, fetchImpl } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-human-push-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const calls = [];
  store.humanPush.configure({
    fetchImpl: fetchImpl ?? (async (url, init) => { calls.push({ url, init }); return reply(201); })
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
  const keys = push === null ? null : await generateVapidKeys();
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
  return { store, send, request, calls, ownerKey, mayaKey, samKey, agentKey, vapid };
}

test("a human mention or DM is pushed, and a reply, work update, agent mention, or self-mention is not", async t => {
  const { store, send, calls, ownerKey, mayaKey, samKey } = await boot(t);
  store.humanPush.save(mayaKey, "commons", browserSub("https://push.example.test/maya"));
  store.humanPush.save(samKey, "commons", browserSub("https://push.example.test/sam"));

  const posted = send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-mention", body: `@Maya ${SECRET}` });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://push.example.test/maya");
  const opened = await openPush(calls[0]);
  assert.deepEqual(opened, { v: 1, roomId: "commons", unread: 1, counts: { mention: 1 }, sequence: posted.sequence });
  assert.equal(JSON.stringify(opened).includes(SECRET), false);
  assert.equal(JSON.stringify(opened).includes("Maya"), false);
  calls.length = 0;

  send(mayaKey, T.MESSAGE_POSTED, { messageId: "m-hello", body: "hello from maya" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-reply", body: "thanks, no ping", replyToId: "m-hello" });
  send(ownerKey, T.WORK_PROPOSED, {
    workItemId: "w1", title: "Maya work", definitionOfDone: "Done", accountableMemberId: "maya", mode: "read"
  });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m-agent", body: "@Test agent please look" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "m-self", body: "@Maya hello again" });
  await store.humanPush.flush();
  assert.equal(calls.length, 0);

  send(ownerKey, T.MESSAGE_POSTED, {
    messageId: "m-dm", body: `@Sam ${SECRET}`, toMemberId: "maya"
  });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://push.example.test/maya");
  const dm = await openPush(calls[0]);
  assert.deepEqual(dm.counts, { dm: 1 });
  assert.equal(JSON.stringify(dm).includes(SECRET), false);
  assert.equal(JSON.stringify(dm).includes("Sam"), false);
});

test("thread and member mutes suppress a push, and turning the in-app feed off does not", async t => {
  const { store, send, calls, ownerKey, mayaKey, samKey } = await boot(t);
  store.humanPush.save(mayaKey, "commons", browserSub("https://push.example.test/maya"));
  send(mayaKey, T.NOTIFICATION_PREFERENCES_SET, { preferences: { mentions: "none" } });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "still", body: "@Maya please still ping" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1, "the fixed default does not consult notification preference levels");
  calls.length = 0;

  send(ownerKey, T.MESSAGE_POSTED, { messageId: "root", body: "thread start" });
  store.threadMutes.set(mayaKey, "commons", { threadId: "root", muted: true });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "in-thread", body: "@Maya in the muted thread", replyToId: "root" });
  await store.humanPush.flush();
  assert.equal(calls.length, 0, "a muted thread is the undo");

  send(samKey, T.MESSAGE_POSTED, { messageId: "from-sam", body: "@Maya from sam" });
  await store.humanPush.flush();
  assert.equal(calls.length, 1);
  calls.length = 0;
  send(mayaKey, T.MEMBER_MUTE_SET, { memberId: "sam", muted: true });
  send(samKey, T.MESSAGE_POSTED, { messageId: "from-sam-2", body: "@Maya after the mute" });
  await store.humanPush.flush();
  assert.equal(calls.length, 0, "a muted member is the undo");
});

test("with no VAPID keys a mention still posts and nothing is sent", async t => {
  const { store, send, calls, request, ownerKey, mayaKey } = await boot(t, { push: null });
  const posted = send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Maya hello" });
  await store.humanPush.flush();
  assert.equal(posted.sequence > 0, true);
  assert.equal(calls.length, 0);
  assert.throws(() => store.humanPush.save(mayaKey, "commons", browserSub("https://push.example.test/maya")),
    error => error.code === "push_not_configured");
  const status = await request("/api/rooms/commons/human-push", { token: mayaKey });
  const body = await status.json();
  assert.equal(status.status, 200);
  assert.equal(body.configured, false);
  assert.equal(body.default, "mentions_and_dms");
  assert.equal(body.publicKey, undefined);
  assert.equal(body.quietHours, undefined);
});

test("a subscription the push service says is gone is retired", async t => {
  const { store, send, ownerKey, mayaKey } = await boot(t, {
    fetchImpl: async () => reply(410)
  });
  store.humanPush.save(mayaKey, "commons", browserSub("https://push.example.test/maya"));
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Maya hello" });
  await store.humanPush.flush();
  const left = store.db.prepare("SELECT COUNT(*) AS n FROM human_push_subscriptions").get().n;
  assert.equal(left, 0);
});

test("the subscription route is humans only, fixed default, and refuses preference fields", async t => {
  const { store, request, mayaKey, agentKey, vapid } = await boot(t);
  const anonymous = await request("/api/rooms/commons/human-push");
  assert.equal(anonymous.status, 401);

  const status = await request("/api/rooms/commons/human-push", { token: mayaKey });
  const statusBody = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusBody.default, "mentions_and_dms");
  assert.equal(statusBody.publicKey, vapid.publicKey);
  assert.equal(JSON.stringify(statusBody).includes(vapid.privateKey), false);
  assert.equal(statusBody.levels, undefined);
  assert.equal(statusBody.quietHours, undefined);

  const agent = await request("/api/rooms/commons/human-push", {
    method: "POST", token: agentKey, data: browserSub("https://push.example.test/agent")
  });
  assert.equal(agent.status, 403);
  assert.equal((await agent.json()).error.code, "human_push_humans_only");

  for (const extra of [{ quietHours: { start: "22:00", end: "07:00" } }, { level: "all" }]) {
    const refused = await request("/api/rooms/commons/human-push", {
      method: "POST", token: mayaKey, data: { ...browserSub("https://push.example.test/maya"), ...extra }
    });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).error.code, "invalid_human_push");
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM human_push_subscriptions").get().n, 0);

  const saved = await request("/api/rooms/commons/human-push", {
    method: "POST", token: mayaKey, data: browserSub("https://push.example.test/maya")
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedBody.saved, true);
  assert.equal(JSON.stringify(savedBody).includes(AUTH_SECRET), false);
  const again = await request("/api/rooms/commons/human-push", {
    method: "POST", token: mayaKey, data: browserSub("https://push.example.test/maya")
  });
  assert.equal(again.status, 200);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM human_push_subscriptions").get().n, 1);

  for (let i = 1; i < 8; i += 1) {
    const more = await request("/api/rooms/commons/human-push", {
      method: "POST", token: mayaKey, data: browserSub(`https://push.example.test/maya-${i}`)
    });
    assert.equal(more.status, 200);
  }
  const limited = await request("/api/rooms/commons/human-push", {
    method: "POST", token: mayaKey, data: browserSub("https://push.example.test/maya-extra")
  });
  assert.equal(limited.status, 409);
  assert.equal((await limited.json()).error.code, "human_push_device_limit");

  const removed = await request("/api/rooms/commons/human-push", {
    method: "DELETE", token: mayaKey, data: { endpoint: "https://push.example.test/maya" }
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM human_push_subscriptions WHERE endpoint=?"
  ).get("https://push.example.test/maya").n, 0);
});
