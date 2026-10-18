import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { buildRoomDigest, DIGEST_MAX_BYTES } from "../server/room-digest.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { readRoomDigest } from "../server/routes/room-digest.mjs";

test("digest route rejects account bearers, non-session cookies, and insufficient API scopes before reading", () => {
  for (const [bearer, auth, code] of [
    [true, { credentialScope: "account" }, "access_denied"],
    [false, { kind: "api-key" }, "unauthenticated"],
    [true, { credentialScope: "room", kind: "api-key", apiKeyScopes: ["inbox:read"] }, "insufficient_scope"]
  ]) {
    assert.throws(() => readRoomDigest({ params: { roomId: "commons" }, req: {},
      url: new URL("https://room.example/api/rooms/commons/digest"),
      roomCredentials: () => ({ bearer, mode: "room", token: "test" }),
      expectedBinding: () => null, roomAuth: () => auth, rate: () => {},
      reject: (_status, errorCode) => { throw Object.assign(new Error(errorCode), { code: errorCode }); },
      store: { roomDigest: () => assert.fail("unauthorized digest read") }
    }), { code });
  }
});

const config = { origin: "https://room.example", roomId: "commons", memberId: "worker", token: "T".repeat(43) };
const session = () => ({ authMode: "room", roomId: "commons", member: { id: "worker", kind: "agent", active: true,
  revision: 0, permissions: [] }, account: null, csrf: null, sessionBinding: null, sessionRevision: null, expiresAt: Date.now() + 3600000 });
const fixture = () => buildRoomDigest({ roomId: "commons", viewerId: "worker", since: 0, through: 8, now: 0,
  context: { context_version: "a".repeat(64) }, byType: { "room.created": 1, "message.posted": 7 },
  messages: [{ id: "message", seq: 8, actorId: "owner", summary: "A source-linked summary" }] });
function client(value, calls = []) {
  return new RoomAgentClient({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), signal: init.signal });
    init.signal?.throwIfAborted();
    return Response.json(new URL(url).pathname === "/api/session" ? session() : value);
  } });
}

test("digest client preserves bounded evidence and uses no snapshot/event walk or acknowledgement", async () => {
  const calls = [], value = fixture(), signal = new AbortController().signal;
  assert.deepEqual(await client(value, calls).roomDigest({ signal }), value);
  assert.deepEqual(calls.map(x => new URL(x.url).pathname), ["/api/session", "/api/rooms/commons/digest"]);
  assert.equal(new URL(calls[1].url).searchParams.get("since"), "0");
  assert.ok(calls.every(x => x.signal instanceof AbortSignal && !x.signal.aborted));
});

test("digest client rejects malformed cursors without fetching", async () => {
  const calls = [], c = client(fixture(), calls);
  for (const since of [-1, 1.5, "0", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(c.roomDigest({ since }), { code: "invalid_cursor" });
  }
  assert.equal(calls.length, 0);
});

test("digest client rejects identity, coverage, omission, byte-budget and follow-up corruption", async () => {
  const changes = [
    v => { v.roomId = "other"; }, v => { v.viewerId = "other"; },
    v => { v.next++; }, v => { v.requestedSince = 1; }, v => { v.coverage.eventsInWindow--; },
    v => { v.coverage.byType["message.posted"]--; }, v => { delete v.bodiesOmitted; },
    v => { v.messages[0].seq = 9; }, v => { v.messages[0].summary = "界".repeat(141); },
    v => { v.followUps.events = "GET https://other.example/private"; },
    v => { v.untrusted = false; }, v => { v.contractVersion = 2; },
    v => { v.extra = "界".repeat(1500); }, v => { v.context.context_version = "unknown"; },
    v => { v.actionableNow.total = 1; }, v => { v.truncated = { unknown: 1 }; }
  ];
  for (const change of changes) {
    const value = fixture(); change(value);
    await assert.rejects(client(value).roomDigest(), { code: "invalid_response" });
  }
});

test("digest client honors floor-clamped windows, caught-up windows and aborts", async () => {
  const floor = buildRoomDigest({ roomId: "commons", viewerId: "worker", requestedSince: 0, since: 7, through: 8, now: 0,
    context: { context_version: "b".repeat(64) }, byType: { "message.posted": 1 } });
  assert.equal((await client(floor).roomDigest()).floorApplied, true);
  const quiet = buildRoomDigest({ roomId: "commons", viewerId: "worker", since: 8, through: 8, now: 0,
    context: { context_version: "b".repeat(64) }, byType: {} });
  assert.equal((await client(quiet).roomDigest({ since: 8 })).coverage.eventsInWindow, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client(fixture()).roomDigest({ signal: controller.signal }), { name: "AbortError" });
});

test("complete digest budget includes UTF-8 summaries, cursor metadata and truncation accounting", () => {
  for (let length = 1; length <= 140; length++) {
    const value = buildRoomDigest({ roomId: "r".repeat(64), viewerId: "v".repeat(64), since: 1, requestedSince: 0, through: 20000, now: 0,
      context: { context_version: "a".repeat(64) }, byType: Object.fromEntries(Object.values(T).map(type => [type, 1])),
      workChanged: Array.from({ length: 4 }, (_, i) => ({ id: `w${i}`, seq: i + 2, title: "x".repeat(80) })),
      messages: Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, seq: i + 2, actorId: "v", summary: "界".repeat(length) })),
      attention: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, seq: i + 2, kind: "mention", summary: "界".repeat(length) })) });
    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= DIGEST_MAX_BYTES, `length ${length}`);
    assert.equal(value.requestedSince, 0); assert.equal(value.floorApplied, true);
    assert.equal(Object.values(value.coverage.byType).reduce((a, b) => a + b, 0), value.coverage.eventsInWindow);
  }
});

test("real server digest supports since-wake reads without marking the window handled", async t => {
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "worker", displayName: "Worker", kind: "agent", permissions: [] });
  const token = store.issueAccessKey("commons", "worker");
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const c = new RoomAgentClient({ ...config, origin: `http://127.0.0.1:${server.address().port}`, token });
  const before = store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", "worker");
  const first = await c.roomDigest();
  send(T.MESSAGE_POSTED, { messageId: "fresh", body: "New evidence for the room" });
  const next = await c.roomDigest({ since: first.next });
  assert.ok(next.messages.some(m => m.id === "fresh"));
  assert.ok(next.messages.every(m => m.seq > first.next));
  assert.deepEqual(store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", "worker"), before);
  await assert.rejects(c.roomDigest({ since: next.next + 100 }), { code: "cursor_ahead" });
});
