// Phase 2 channels (Discord/Slack-like): the default main channel, user-created
// channels, and per-channel message tagging — at the reducer level and through
// the HTTP command path.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  EVENT_TYPES as T, DEFAULT_CHANNEL_ID, applyEvent, replay,
  normalizeChannelName, messageChannelId, channelList
} from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { COMMAND_TYPES } from "../server/store.mjs";
import { classifyCommand } from "../server/action-classes.mjs";

const ROOM_ID = "room-project-room-v0";
const baseState = () => replay(seedEvents);
const fixedEvent = (id, type, actorId, data, at = "2026-09-05T10:00:00.000Z") => ({
  id, idempotencyKey: `key-${id}`, roomId: ROOM_ID, type, actorId, at, causationId: null, data
});
const post = (id, actorId, data, at) =>
  fixedEvent(id, T.MESSAGE_POSTED, actorId, { body: "hello", ...data }, at);
const mkChannel = (id, actorId, data, at) =>
  fixedEvent(id, T.CHANNEL_CREATED, actorId, data, at);

test("room creation seeds the default main channel", () => {
  const state = baseState();
  assert.deepEqual(state.channels[DEFAULT_CHANNEL_ID], {
    id: "general", name: "general", createdBy: "potter",
    createdAt: "2026-09-05T09:00:00.000Z", archivedAt: null
  });
});

test("messages without a channel land in the main channel", () => {
  const state = applyEvent(baseState(), post("m1", "maya", {}));
  const message = state.messages.at(-1);
  assert.equal(message.channelId, "general");
  assert.equal(messageChannelId(message), "general");
});

test("legacy rooms without channels backfill the main channel on replay", () => {
  const legacy = baseState();
  delete legacy.channels;
  legacy.messages.forEach(m => { delete m.channelId; });
  const next = applyEvent(legacy, post("m2", "maya", {}));
  assert.ok(next.channels[DEFAULT_CHANNEL_ID], "default channel backfilled");
  assert.equal(next.channels[DEFAULT_CHANNEL_ID].createdBy, "potter");
  assert.equal(messageChannelId(next.messages[0]), "general", "legacy messages read as main-channel");
  assert.equal(next.messages.at(-1).channelId, "general");
});

test("a member can create a channel; names normalize", () => {
  let state = applyEvent(baseState(), mkChannel("ch-design", "maya", { name: "Design Team" }));
  assert.deepEqual(state.channels["ch-design"], {
    id: "ch-design", name: "design-team", createdBy: "maya",
    createdAt: "2026-09-05T10:00:00.000Z", archivedAt: null
  });
  assert.equal(normalizeChannelName("  Announcements  "), "announcements");
  assert.throws(() => normalizeChannelName("has spaces!"), /Channel name/);
  assert.throws(() => normalizeChannelName(""), /Channel name/);
  assert.throws(() => normalizeChannelName("x".repeat(49)), /Channel name/);
  assert.throws(() => applyEvent(state, mkChannel("ch-dup", "maya", { name: "design-team" })), /name is taken/);
  assert.throws(() => applyEvent(state, mkChannel("ch-bad", "maya", { name: "Nope!" })), /Channel name/);
  assert.throws(() => applyEvent(state, mkChannel("ch-nonmember", "stranger", { name: "x" })), /member/i);
});

test("channel ids default to the event id and must be unique", () => {
  const state = applyEvent(baseState(), fixedEvent("evt-ch", T.CHANNEL_CREATED, "maya", { name: "random" }));
  assert.equal(state.channels["evt-ch"].id, "evt-ch");
  assert.throws(() => applyEvent(state, fixedEvent("evt-ch2", T.CHANNEL_CREATED, "maya", { channelId: "evt-ch", name: "other" })), /already exists/);
});

test("messages post into the addressed channel; unknown channels are rejected", () => {
  let state = applyEvent(baseState(), mkChannel("ch-design", "maya", { name: "design" }));
  state = applyEvent(state, post("m3", "maya", { channelId: "ch-design" }));
  assert.equal(state.messages.at(-1).channelId, "ch-design");
  assert.equal(messageChannelId(state.messages.at(-1)), "ch-design");
  assert.throws(() => applyEvent(state, post("m4", "maya", { channelId: "nope" })), /Unknown channel/);
});

test("only the room owner renames or archives channels", () => {
  let state = applyEvent(baseState(), mkChannel("ch-design", "maya", { name: "design" }));
  assert.throws(() => applyEvent(state, fixedEvent("r1", T.CHANNEL_RENAMED, "maya", { channelId: "ch-design", name: "ux" })), /Only the Room owner/);
  assert.throws(() => applyEvent(state, fixedEvent("a1", T.CHANNEL_ARCHIVED, "maya", { channelId: "ch-design" })), /Only the Room owner/);
  state = applyEvent(state, fixedEvent("r2", T.CHANNEL_RENAMED, "potter", { channelId: "ch-design", name: "UX Work" }));
  assert.equal(state.channels["ch-design"].name, "ux-work");
  assert.throws(() => applyEvent(state, fixedEvent("r3", T.CHANNEL_RENAMED, "potter", { channelId: "ch-design", name: "general" })), /name is taken/);
  state = applyEvent(state, fixedEvent("a2", T.CHANNEL_ARCHIVED, "potter", { channelId: "ch-design" }));
  assert.ok(state.channels["ch-design"].archivedAt, "archived");
  state = applyEvent(state, fixedEvent("a3", T.CHANNEL_ARCHIVED, "potter", { channelId: "ch-design" }));
  assert.ok(state.channels["ch-design"].archivedAt, "archiving is idempotent");
  assert.throws(() => applyEvent(state, post("m5", "maya", { channelId: "ch-design" })), /archived/);
  assert.throws(() => applyEvent(state, fixedEvent("a4", T.CHANNEL_ARCHIVED, "potter", { channelId: "general" })), /can't be archived/);
});

test("channelList puts the main channel first, then oldest first", () => {
  let state = baseState();
  state = applyEvent(state, mkChannel("ch-b", "maya", { name: "b" }, "2026-09-05T11:00:00.000Z"));
  state = applyEvent(state, mkChannel("ch-a", "maya", { name: "a" }, "2026-09-05T10:30:00.000Z"));
  assert.deepEqual(channelList(state).map(c => c.id), ["general", "ch-a", "ch-b"]);
});

test("the new command types are classified act and accepted by the command surface", () => {
  for (const type of [T.CHANNEL_CREATED, T.CHANNEL_RENAMED, T.CHANNEL_ARCHIVED]) {
    assert.ok(COMMAND_TYPES.includes(type), `${type} is a command`);
    assert.equal(classifyCommand(type), "act");
  }
});

async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("http: channel lifecycle through /commands and per-channel posting", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await serve(t, f);
  const send = (key, command) => fetch(origin + "/api/rooms/commons/commands", { method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(command) });

  // Fixture messages posted without channelId read as main-channel.
  const welcome = f.store.room("commons").state.messages.find(m => m.id === "test-welcome");
  assert.equal(welcome.channelId, "general");

  let res = await send(f.keys.owner, { id: randomUUID(), type: T.CHANNEL_CREATED, data: { name: "Design!!" } });
  assert.equal(res.status, 422, "bad name rejected");
  res = await send(f.keys.owner, { id: randomUUID(), type: T.CHANNEL_CREATED, data: { name: "design" } });
  assert.equal(res.status, 201);
  const created = Object.values(f.store.room("commons").state.channels).find(c => c.name === "design");
  assert.ok(created, "channel created");

  res = await send(f.keys.owner, { id: randomUUID(), type: T.CHANNEL_CREATED, data: { name: "design" } });
  assert.equal(res.status, 422, "duplicate name rejected");

  res = await send(f.keys.guest, { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "mockup v2", channelId: created.id } });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).event.data.channelId, created.id);

  res = await send(f.keys.guest, { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "lost", channelId: "no-such-channel" } });
  assert.equal(res.status, 422, "unknown channel rejected");

  res = await send(f.keys.guest, { id: randomUUID(), type: T.CHANNEL_RENAMED,
    data: { channelId: created.id, name: "ux" } });
  assert.equal(res.status, 422, "non-owner rename rejected");
  res = await send(f.keys.owner, { id: randomUUID(), type: T.CHANNEL_RENAMED,
    data: { channelId: created.id, name: "ux" } });
  assert.equal(res.status, 201);
  assert.equal(f.store.room("commons").state.channels[created.id].name, "ux");

  res = await send(f.keys.owner, { id: randomUUID(), type: T.CHANNEL_ARCHIVED, data: { channelId: created.id } });
  assert.equal(res.status, 201);
  res = await send(f.keys.guest, { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "too late", channelId: created.id } });
  assert.equal(res.status, 422, "archived channel rejects posts");
});

test("replies pin to their thread root's channel and can't drift across channels", () => {
  let state = baseState();
  const at = "2026-09-05T10:00:00.000Z";
  state = applyEvent(state, fixedEvent("e1", T.CHANNEL_CREATED, "maya", { channelId: "c-design", name: "design" }, at));
  state = applyEvent(state, fixedEvent("e2", T.MESSAGE_POSTED, "maya",
    { messageId: "m-root", body: "root in design", channelId: "c-design" }, at));
  // A reply carrying the wrong channel (or none) still lands in the root's channel.
  state = applyEvent(state, fixedEvent("e3", T.MESSAGE_POSTED, "maya",
    { messageId: "m-reply", body: "reply", replyToId: "m-root", channelId: "general" }, at));
  state = applyEvent(state, fixedEvent("e4", T.MESSAGE_POSTED, "maya",
    { messageId: "m-nested", body: "nested", replyToId: "m-reply" }, at));
  const byId = id => state.messages.find(m => m.id === id);
  assert.equal(byId("m-reply").channelId, "c-design", "reply pinned to root channel despite explicit general");
  assert.equal(byId("m-nested").channelId, "c-design", "nested reply follows the root through its parent");
  assert.throws(() => applyEvent(state, fixedEvent("e5", T.MESSAGE_POSTED, "maya",
    { messageId: "m-bad", body: "bad", replyToId: "missing" }, at)),
    /Reply must reference a message in this Room/);
});

test("legacy stored projections gain #general in memory on load", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RoomStore } = await import("../server/store.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const directory = mkdtempSync(join(tmpdir(), "project-room-channels-upgrade-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    store.initialize(initialRoom());
    // Simulate a legacy projection stored before channels existed.
    const row = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
    const legacy = JSON.parse(row.projection);
    delete legacy.channels;
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(legacy));
    // The stored bytes stay untouched...
    const stored = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
    assert.ok(!stored.channels, "stored projection unchanged");
    // ...but loads backfill #general in memory, matching a full replay.
    const loaded = store.room("commons").state;
    assert.ok(loaded.channels?.[DEFAULT_CHANNEL_ID], "load backfills #general");
    const rebuilt = store.rebuildProjection("commons").state;
    assert.deepEqual(loaded.channels, rebuilt.channels, "loaded and rebuilt channels match");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
