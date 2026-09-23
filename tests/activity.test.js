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

// Attention: activity feed fan-out, read horizons, saved messages, thread mutes.
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-activity-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Agent", kind: "agent", permissions: [] });
  keys.maya = store.issueAccessKey("commons", "maya");
  keys.agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send };
}

const post = (f, actor, data, id = randomUUID()) => f.send(actor, T.MESSAGE_POSTED, data, id).event.data.messageId || id;
const eventsFor = (f, userId) =>
  f.store.db.prepare("SELECT type, actor_id AS actorId, message_id AS messageId FROM activity_events WHERE user_id=? ORDER BY id").all(userId);

test("mention fan-out: named members get events, the sender never does", t => {
  const f = setup(t);
  post(f, "owner", { messageId: "m1", body: "hey @agent and @maya, look" });
  assert.deepEqual(eventsFor(f, "agent").map(e => [e.type, e.actorId, e.messageId]), [["mention", "owner", "m1"]]);
  assert.deepEqual(eventsFor(f, "maya").map(e => [e.type, e.actorId]), [["mention", "owner"]]);
  assert.deepEqual(eventsFor(f, "owner"), [], "no self-events");
});

test("unresolved and self mentions produce nothing", t => {
  const f = setup(t);
  post(f, "maya", { messageId: "m1", body: "hi @nobody and @maya" });
  assert.deepEqual(eventsFor(f, "maya"), [], "@maya is the sender");
  assert.deepEqual(eventsFor(f, "agent"), [], "@nobody resolves to nobody");
});

test("reply fan-out: the parent author gets a reply event", t => {
  const f = setup(t);
  post(f, "agent", { messageId: "root", body: "hello" });
  post(f, "maya", { messageId: "r1", body: "answering", replyToId: "root" });
  assert.deepEqual(eventsFor(f, "agent").map(e => [e.type, e.messageId]), [["reply", "r1"]]);
  assert.deepEqual(eventsFor(f, "maya"), [], "the replier gets no event for their own reply");
});

test("mention wins over reply and thread_reply for the same recipient", t => {
  const f = setup(t);
  post(f, "agent", { messageId: "root", body: "hello" });
  post(f, "maya", { messageId: "r1", body: "@agent exactly", replyToId: "root" });
  const rows = eventsFor(f, "agent");
  assert.equal(rows.length, 1, "one event only");
  assert.equal(rows[0].type, "mention");
});

test("thread replies notify the other participants as thread_reply", t => {
  const f = setup(t);
  post(f, "owner", { messageId: "root", body: "thread start" });
  post(f, "maya", { messageId: "r1", body: "first", replyToId: "root" });
  post(f, "agent", { messageId: "r2", body: "second", replyToId: "r1" });
  // r1: owner gets reply (parent author beats thread_reply); agent is not yet a participant.
  // r2: owner and maya get thread_reply; agent gets nothing for their own post.
  assert.deepEqual(eventsFor(f, "owner").map(e => [e.type, e.messageId]), [["reply", "r1"], ["thread_reply", "r2"]]);
  assert.deepEqual(eventsFor(f, "maya").map(e => [e.type, e.messageId]), [["reply", "r2"]], "maya is r1's author: reply beats thread_reply");
  assert.deepEqual(eventsFor(f, "agent"), []);
});

test("thread mutes suppress thread_reply events but not mentions", t => {
  const f = setup(t);
  post(f, "owner", { messageId: "root", body: "thread start" });
  post(f, "maya", { messageId: "r1", body: "first", replyToId: "root" });
  f.store.db.prepare("INSERT INTO thread_mutes (room_id,member_id,thread_id,created_at) VALUES('commons','maya','root',1)").run();
  post(f, "agent", { messageId: "r2", body: "second", replyToId: "r1" });
  post(f, "agent", { messageId: "r3", body: "@maya ping", replyToId: "r1" });
  assert.deepEqual(eventsFor(f, "maya").map(e => [e.type, e.messageId]), [["reply", "r2"], ["mention", "r3"]],
    "mute kills thread_reply; a direct reply to your own message and mentions still arrive");
});

test("reaction fan-out: reacting notifies the message author; unreacting retracts the pending event", t => {
  const f = setup(t);
  post(f, "agent", { messageId: "m1", body: "post" });
  f.send("maya", T.MESSAGE_REACTION_SET, { messageId: "m1", reaction: "like", active: true });
  assert.deepEqual(eventsFor(f, "agent").map(e => [e.type, e.actorId]), [["reaction", "maya"]]);
  f.send("maya", T.MESSAGE_REACTION_SET, { messageId: "m1", reaction: "like", active: false });
  assert.deepEqual(eventsFor(f, "agent"), [], "toggle-off removes the unread reaction event");
});

test("reactions to your own message and read-then-unreacted events are left alone", t => {
  const f = setup(t);
  post(f, "agent", { messageId: "m1", body: "post" });
  f.send("agent", T.MESSAGE_REACTION_SET, { messageId: "m1", reaction: "like", active: true });
  assert.deepEqual(eventsFor(f, "agent"), [], "no self-events on reactions");
  f.send("maya", T.MESSAGE_REACTION_SET, { messageId: "m1", reaction: "like", active: true });
  f.store.db.prepare("UPDATE activity_events SET read_at=1 WHERE user_id='agent'").run();
  f.send("maya", T.MESSAGE_REACTION_SET, { messageId: "m1", reaction: "like", active: false });
  assert.equal(eventsFor(f, "agent").length, 1, "a read event is history, not retracted");
});

test("replayed commands never duplicate activity events", t => {
  const f = setup(t);
  const id = randomUUID();
  f.send("owner", T.MESSAGE_POSTED, { messageId: "m1", body: "hey @agent" }, id);
  f.send("owner", T.MESSAGE_POSTED, { messageId: "m1", body: "hey @agent" }, id);
  assert.equal(eventsFor(f, "agent").length, 1, "unique key makes the replay a no-op");
});

test("DM mentions stay between the DM parties", t => {
  const f = setup(t);
  f.store.dmConsents.request("commons", "owner", "maya", "test fixture");
  f.store.dmConsents.decide("commons", "maya", "owner", "approve");
  post(f, "owner", { messageId: "dm1", body: "hey @agent, secret", toMemberId: "maya" });
  assert.deepEqual(eventsFor(f, "agent"), [], "a third member never learns of the DM");
  assert.deepEqual(eventsFor(f, "maya").map(e => [e.type, e.messageId]), [["mention", "dm1"]]);
});

// --- HTTP routes ---------------------------------------------------------------

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-activity-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
  const mayaKey = store.issueAccessKey("commons", "maya");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const call = async (path, opts) => { const res = await request(path, opts); return { status: res.status, body: await res.json() }; };
  return { store, send, call, ownerKey, mayaKey };
}

const seedActivity = f => {
  f.send(f.ownerKey, T.MESSAGE_POSTED, { messageId: "root", body: "hello @maya" });
  f.send(f.mayaKey, T.MESSAGE_POSTED, { messageId: "r1", body: "replying", replyToId: "root" });
  f.send(f.ownerKey, T.MESSAGE_REACTION_SET, { messageId: "r1", reaction: "like", active: true });
};

test("activity list: paging, type filter, and validation", async t => {
  const f = await serve(t);
  seedActivity(f);
  const list = (token, query = "") => f.call(`/api/rooms/commons/activity${query}`, { token });
  const { status, body } = await list(f.mayaKey);
  assert.equal(status, 200);
  assert.equal(body.items.length, 2, "mention + reaction for maya; the reply went to owner");
  assert.deepEqual(body.items.map(i => i.type), ["reaction", "mention"], "newest first");
  assert.ok(body.items.every(i => i.messageBody && i.actorId), "joined message view");
  const filtered = await list(f.mayaKey, "?type=mention");
  assert.deepEqual(filtered.body.items.map(i => i.type), ["mention"]);
  const paged = await list(f.mayaKey, "?limit=1");
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.hasMore, true);
  const second = await list(f.mayaKey, `?limit=1&before=${paged.body.items[0].id}`);
  assert.equal(second.body.items.length, 1);
  assert.notEqual(second.body.items[0].id, paged.body.items[0].id);
  assert.equal((await list(f.mayaKey, "?type=bogus")).status, 422);
  assert.equal((await list(f.mayaKey, "?limit=500")).status, 422);
  assert.equal((await list(f.mayaKey, "?before=nope")).status, 422);
  assert.equal((await f.call("/api/rooms/commons/activity")).status, 401, "no credential, no feed");
});

test("unread count, mark read, mark all read", async t => {
  const f = await serve(t);
  seedActivity(f);
  const count = () => f.call("/api/rooms/commons/activity-unread-count", { token: f.mayaKey }).then(r => r.body);
  assert.deepEqual((await count()).byType, { mention: 1, reply: 0, thread_reply: 0, reaction: 1 });
  assert.equal((await count()).total, 2);
  const first = (await f.call("/api/rooms/commons/activity", { token: f.mayaKey })).body.items;
  const reaction = first.find(i => i.type === "reaction");
  const marked = await f.call("/api/rooms/commons/activity-read", { method: "POST", token: f.mayaKey, data: { ids: [reaction.id] } });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.read, 1);
  assert.equal((await count()).total, 1);
  assert.equal((await f.call("/api/rooms/commons/activity-read", { method: "POST", token: f.ownerKey, data: { ids: [reaction.id] } })).body.read, 0, "cannot mark another member's events");
  const all = await f.call("/api/rooms/commons/activity-read-all", { method: "POST", token: f.mayaKey, data: { type: "mention" } });
  assert.equal(all.body.read, 1);
  assert.equal((await count()).total, 0);
  assert.equal((await f.call("/api/rooms/commons/activity-read", { method: "POST", token: f.mayaKey, data: { ids: [] } })).status, 422);
});

test("read horizons: set, get, rewind, and validation", async t => {
  const f = await serve(t);
  seedActivity(f);
  const get = (token, query = "") => f.call(`/api/rooms/commons/read-horizon${query}`, { token });
  assert.equal((await get(f.mayaKey)).body.lastReadMessageId, null, "no horizon yet");
  const set = (token, data) => f.call("/api/rooms/commons/read-horizon", { method: "POST", token, data });
  assert.equal((await set(f.mayaKey, { lastReadMessageId: "root" })).status, 200);
  assert.equal((await get(f.mayaKey)).body.lastReadMessageId, "root");
  // Rewind: the horizon moves back to an older message, unlike the caught-up cursor.
  assert.equal((await set(f.mayaKey, { threadId: "thread-1", lastReadMessageId: "root" })).body.threadId, "thread-1");
  assert.equal((await get(f.mayaKey, "?threadId=thread-1")).body.lastReadMessageId, "root");
  assert.equal((await set(f.mayaKey, { lastReadMessageId: null })).body.lastReadMessageId, null, "null clears the horizon");
  assert.equal((await set(f.mayaKey, { lastReadMessageId: "missing" })).status, 404);
  assert.equal((await set(f.mayaKey, {})).status, 422);
  assert.equal((await f.call("/api/rooms/commons/read-horizon")).status, 401);
});

test("saved messages: save, list, unsave, ownership isolation", async t => {
  const f = await serve(t);
  seedActivity(f);
  const save = (token, data, method = "POST") => f.call("/api/rooms/commons/saved", { method, token, data });
  assert.equal((await save(f.mayaKey, { messageId: "root", saved: true })).status, 200);
  assert.equal((await save(f.mayaKey, { messageId: "root", saved: true })).status, 200, "idempotent save");
  const listed = (await f.call("/api/rooms/commons/saved", { token: f.mayaKey })).body;
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].messageId, "root");
  assert.ok(listed.items[0].body.includes("hello"), "live body joined");
  assert.equal((await f.call("/api/rooms/commons/saved", { token: f.ownerKey })).body.items.length, 0, "saves are per-member");
  assert.equal((await save(f.mayaKey, { messageId: "root" }, "DELETE")).status, 200);
  assert.equal((await f.call("/api/rooms/commons/saved", { token: f.mayaKey })).body.items.length, 0);
  assert.equal((await save(f.mayaKey, { messageId: "missing", saved: true })).status, 404);
  assert.equal((await save(f.mayaKey, { messageId: "root", saved: "yes" })).status, 422);
});

test("deleted messages cannot be saved", async t => {
  const f = await serve(t);
  f.send(f.ownerKey, T.MESSAGE_POSTED, { messageId: "gone", body: "bye" });
  f.send(f.ownerKey, T.MESSAGE_DELETED, { messageId: "gone", expectedMessageRevision: 0 });
  assert.equal((await f.call("/api/rooms/commons/saved", { method: "POST", token: f.mayaKey, data: { messageId: "gone", saved: true } })).status, 409);
});

test("thread mutes: mute and unmute persist per member", async t => {
  const f = await serve(t);
  seedActivity(f);
  const mute = (token, data) => f.call("/api/rooms/commons/thread-mutes", { method: "POST", token, data });
  assert.deepEqual((await mute(f.mayaKey, { threadId: "r1", muted: true })).body, { roomId: "commons", threadId: "root", muted: true }, "child message resolves to the thread root");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM thread_mutes").get().n, 1);
  assert.deepEqual((await mute(f.mayaKey, { threadId: "root", muted: false })).body.muted, false);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM thread_mutes").get().n, 0);
  assert.equal((await mute(f.mayaKey, { threadId: "missing", muted: true })).status, 404);
  assert.equal((await mute(f.mayaKey, { threadId: "root" })).status, 422);
  assert.equal((await f.call("/api/rooms/commons/thread-mutes", { method: "POST", data: { threadId: "root", muted: true } })).status, 401);
});
