// Room flood guard: 30 chat posts, then 429 rate_limited with retryAfterMs.
// Keyed by room and member. Replays do not count. Work and bond commands do.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { createRoomFloodGuard } from "../server/room-flood-guard.mjs";

function openStore(t, now = () => Date.now()) {
  const directory = mkdtempSync(join(tmpdir(), "room-flood-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now });
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("lab"));
  const keys = {
    owner: store.issueAccessKey("commons", "owner"),
    lab: store.issueAccessKey("lab", "owner"),
  };
  store.command(keys.owner, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "alice", displayName: "Alice", kind: "human", permissions: [] },
  });
  keys.alice = store.issueAccessKey("commons", "alice");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = (actor, type, data, id = randomUUID(), roomId = "commons") =>
    store.command(keys[actor], roomId, { id, type, data });
  return { store, keys, send };
}

const post = (f, actor, n, roomId = "commons", extra = {}) =>
  f.send(actor, T.MESSAGE_POSTED, { messageId: `m-${actor}-${n}`, body: `hello ${n}`, ...extra }, `c-${actor}-${n}`, roomId);

function assertLimited(error) {
  assert.equal(error.status, 429);
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retryAfterMs, 2000);
  assert.equal(error.headers["Retry-After"], "2");
  assert.equal(error.message, "on 429, wait Retry-After and retry");
  return true;
}

test("30 posts pass, the 31st is 429, and a refilled bucket posts again", t => {
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const f = openStore(t, () => clock.now);
  for (let i = 0; i < 29; i++) post(f, "owner", i);
  post(f, "owner", 29, "commons", { replyToId: "m-owner-0" });
  assert.throws(() => post(f, "owner", 30, "commons", { replyToId: "m-owner-0" }), assertLimited);
  clock.now += 2000;
  post(f, "owner", 31);
});

test("members and rooms have separate budgets", t => {
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const f = openStore(t, () => clock.now);
  for (let i = 0; i < 30; i++) post(f, "owner", i);
  post(f, "alice", 0);
  post(f, "lab", 0, "lab");
  assert.throws(() => post(f, "owner", 30), assertLimited);
});

test("replaying a command id does not count, including while limited", t => {
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const f = openStore(t, () => clock.now);
  const data = { messageId: "m-owner-0", body: "hello 0" };
  f.send("owner", T.MESSAGE_POSTED, data, "c-owner-0");
  assert.equal(f.send("owner", T.MESSAGE_POSTED, data, "c-owner-0").duplicate, true);
  for (let i = 1; i < 30; i++) post(f, "owner", i);
  assert.throws(() => post(f, "owner", 30), assertLimited);
  assert.equal(f.send("owner", T.MESSAGE_POSTED, data, "c-owner-0").duplicate, true);
});

function notLimited(error) {
  assert.notEqual(error.status, 429);
  assert.notEqual(error.code, "rate_limited");
  return true;
}

test("only chat posts and replies count; reactions, edits, deletes, reads, work, and claims do not", t => {
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const f = openStore(t, () => clock.now);
  post(f, "owner", 0);
  f.send("owner", T.MESSAGE_EDITED, { messageId: "m-owner-0", body: "edited", expectedMessageRevision: 0 }, "edit-1");
  f.send("owner", T.MESSAGE_REACTION_SET, { messageId: "m-owner-0", reaction: "like", active: true }, "react-1");
  f.send("owner", T.MESSAGE_DELETED, { messageId: "m-owner-0", expectedMessageRevision: 1, reason: "cleanup" }, "delete-1");
  for (let i = 1; i < 29; i++) post(f, "owner", i);
  try {
    f.send("owner", T.DM_POSTED, { to: "ai_nobody", body: "ping", messageId: "dm-1" }, "dm-1");
  } catch (error) { assert.ok(notLimited(error)); }
  assert.throws(() => post(f, "owner", 29), assertLimited);
  f.send("owner", T.WORK_PROPOSED, {
    workItemId: "w1", title: "Help", definitionOfDone: "Done", accountableMemberId: "owner",
  }, "work-1");
  try {
    f.send("owner", T.CLAIM_ACQUIRED, {
      workItemId: "w1", expectedRevision: 0, repository: "https://example.test/agenda",
      ref: "draft", paths: ["agenda.md"], expiresAt: "2030-01-01T00:00:00.000Z",
    }, "claim-1");
  } catch (error) { assert.ok(notLimited(error)); }
  f.send("owner", "bond.list", {}, "bond-list-1");
  for (let i = 0; i < 5; i++) {
    f.store.snapshot(f.keys.owner, "commons");
    f.store.search(f.keys.owner, "commons", "hello");
  }
  assert.throws(() => post(f, "owner", 30), assertLimited);
});

test("importing chat history does not spend the live budget", t => {
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const f = openStore(t, () => clock.now);
  const exported = [...f.store.exportEvents(f.keys.owner, "commons")];
  const imported = exported.map(line => ({ ...line }));
  for (let i = 0; i < 40; i++) {
    imported.push({
      sequence: exported.length + i + 1,
      event: {
        id: `imp-${i}`, idempotencyKey: `imp-key-${i}`, roomId: "commons",
        type: T.MESSAGE_POSTED, actorId: "owner", at: "2026-09-24T12:00:00.000Z",
        causationId: null, data: { messageId: `imp-m-${i}`, body: `imported ${i}` },
      },
    });
  }
  f.store.importEvents(f.keys.owner, "commons", imported);
  for (let i = 0; i < 30; i++) post(f, "owner", i);
  assert.throws(() => post(f, "owner", 30), assertLimited);
});

test("room_post_message surfaces 429 rate_limited and a replay does not", async t => {
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const directory = mkdtempSync(join(tmpdir(), "room-flood-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  const rooms = new AgentRooms(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create("Flood owner");
  const created = rooms.create(owner.secret, {
    roomId: "flood-den", title: "Flood", purpose: "Post budget", kind: "personal", displayName: "Flood owner",
  });
  const mcp = createHostedRoomMcp(store);
  const call = (body, id) => mcp({
    jsonrpc: "2.0", id: "t", method: "tools/call",
    params: { name: "room_post_message", arguments: { roomId: created.roomId, id, messageId: id, body } },
  }, { authorization: `Bearer ${owner.secret}` });
  for (let i = 0; i < 30; i++) {
    const ok = await call(`hello ${i}`, `post-${i}`);
    assert.equal(ok.result?.isError, undefined, JSON.stringify(ok.result?.structuredContent ?? ok.error));
    assert.equal(ok.result.structuredContent.status, "posted");
  }
  const limited = await call("too fast", "post-30");
  assert.equal(limited.error, undefined);
  assert.equal(limited.result.isError, true);
  const value = limited.result.structuredContent;
  assert.equal(value.status, 429);
  assert.equal(value.code, "rate_limited");
  assert.equal(value.message, "on 429, wait Retry-After and retry");
  const replay = await call("hello 0", "post-0");
  assert.notEqual(replay.result.isError, true);
  assert.equal(replay.result.structuredContent.status, "duplicate");
});


test("dm.posted spends from the same budget as message.posted (guard unit level)", () => {
  // Route-level DM posting needs identity-linked agents (bonds.mjs); the
  // budget rule itself lives in the guard, so pin it here directly.
  const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };
  const guard = createRoomFloodGuard({ now: () => clock.now });
  for (let i = 0; i < 25; i++) guard.consume("commons", "alice", "message.posted");
  for (let i = 0; i < 5; i++) guard.consume("commons", "alice", "dm.posted");
  assert.throws(() => guard.consume("commons", "alice", "message.posted"), error => {
    assert.equal(error.status, 429);
    assert.equal(error.headers["Retry-After"], "2");
    return true;
  }, "26th chat-equivalent is limited after 25 posts + 5 DMs: DMs are not a side channel");
  clock.now += 2000;
  guard.consume("commons", "alice", "dm.posted");
});
