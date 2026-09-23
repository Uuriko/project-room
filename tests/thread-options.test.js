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
import { deriveNotifications } from "../server/notifications.mjs";

// Thread options: "also send to channel" on thread replies, and per-thread
// mutes (private side table suppressing a thread's activity from the
// notification/unread feed).
async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-thread-options-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["steer", "accept_work", "complete_work", "verify"] });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] });
  const mayaKey = store.issueAccessKey("commons", "maya"), agentKey = store.issueAccessKey("commons", "agent");
  store.dmConsents.request("commons", "owner", "agent", "test fixture");
  store.dmConsents.decide("commons", "agent", "owner", "approve");
  store.dmConsents.request("commons", "maya", "agent", "test fixture");
  store.dmConsents.decide("commons", "agent", "maya", "approve");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const json = async res => ({ status: res.status, body: await res.json() });
  return { store, request, json, send, ownerKey, mayaKey, agentKey };
}

const messages = store => store.room("commons").state.messages;
const byId = (store, id) => messages(store).find(m => m.id === id);

// --- also send to channel -------------------------------------------------

test("alsoSendToChannel posts the reply plus a top-level channel copy", async t => {
  const { send, mayaKey, agentKey, store } = await serve(t);
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "root-1", body: "Thread root" });
  send(agentKey, T.MESSAGE_POSTED, { messageId: "reply-1", body: "Reply with copy", replyToId: "root-1", alsoSendToChannel: true });
  const reply = byId(store, "reply-1"), copy = byId(store, "reply-1:channel");
  assert.ok(reply, "the reply is posted");
  assert.equal(reply.replyToId, "root-1");
  assert.ok(copy, "the channel copy is posted");
  assert.equal(copy.replyToId, null, "the copy is top-level");
  assert.equal(copy.toMemberId, null);
  assert.equal(copy.body, "Reply with copy");
  assert.equal(copy.authorId, "agent");
  assert.equal(copy.channelId, reply.channelId, "the copy lands in the thread's channel");
  assert.equal(copy.createdAt, reply.createdAt);
});

test("alsoSendToChannel is ignored for top-level messages, DMs and proposals", async t => {
  const { send, mayaKey, agentKey, ownerKey, store } = await serve(t);
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "top-1", body: "Top level", alsoSendToChannel: true });
  assert.equal(messages(store).filter(m => m.id.startsWith("top-1")).length, 1, "no copy for a top-level message");
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "dm-1", body: "Secret", toMemberId: "agent", replyToId: "top-1", alsoSendToChannel: true });
  assert.equal(byId(store, "dm-1:channel"), undefined, "no channel copy of a DM");
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w1", title: "Work", definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" });
  send(agentKey, T.MESSAGE_POSTED, { messageId: "prop-1", body: "Proposal note", replyToId: "top-1", workItemId: "w1", alsoSendToChannel: true });
  assert.equal(byId(store, "prop-1:channel"), undefined, "no copy for a work proposal");
});

test("alsoSendToChannel pins the copy to the thread root's channel", async t => {
  const { send, mayaKey, agentKey, ownerKey, store } = await serve(t);
  send(ownerKey, T.CHANNEL_CREATED, { channelId: "random", name: "random" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "root-chan", body: "Root in random", channelId: "random" });
  // Replies pin to the thread root's channel no matter what channelId the
  // command carries; the channel copy follows the same rule.
  send(agentKey, T.MESSAGE_POSTED, { messageId: "reply-chan", body: "Reply", replyToId: "root-chan", channelId: "general", alsoSendToChannel: true });
  assert.equal(byId(store, "reply-chan:channel").channelId, "random");
});

test("alsoSendToChannel stays idempotent on command retry", async t => {
  const { send, mayaKey, agentKey, store } = await serve(t);
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "root-r", body: "Root" });
  const data = { messageId: "reply-r", body: "Reply", replyToId: "root-r", alsoSendToChannel: true };
  store.command(agentKey, "commons", { id: "cmd-1", type: T.MESSAGE_POSTED, data });
  assert.throws(() => store.command(agentKey, "commons", { id: "cmd-1b", type: T.MESSAGE_POSTED, data }),
    /Message already exists/, "retrying the same message is rejected, not duplicated");
  assert.equal(messages(store).filter(m => m.id === "reply-r:channel").length, 1, "exactly one channel copy");
});

test("alsoSendToChannel must be a boolean", async t => {
  const { send, mayaKey, agentKey } = await serve(t);
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "root-b", body: "Root" });
  assert.throws(() => send(agentKey, T.MESSAGE_POSTED, { messageId: "reply-b", body: "x", replyToId: "root-b", alsoSendToChannel: "yes" }),
    /Invalid field: alsoSendToChannel/);
});

// --- thread mutes -----------------------------------------------------------

test("thread mutes: set, list, resolve-to-root, unset", async t => {
  const { request, json, send, mayaKey, agentKey } = await serve(t);
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "t-root", body: "Thread root" });
  send(agentKey, T.MESSAGE_POSTED, { messageId: "t-reply", body: "A reply", replyToId: "t-root" });
  const path = "/api/rooms/commons/thread-mutes";
  let res = await json(await request(path, { token: agentKey }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.threadIds, []);
  // Muting by a reply id resolves to the thread root.
  res = await json(await request(path, { method: "POST", token: agentKey, data: { threadId: "t-reply", muted: true } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.roomId, "commons");
  assert.equal(res.body.memberId, "agent");
  assert.equal(res.body.threadId, "t-root");
  assert.equal(res.body.muted, true);
  assert.equal(res.body.viewerId, "agent", "the viewer ownership envelope rides along");
  res = await json(await request(path, { token: agentKey }));
  assert.deepEqual(res.body.threadIds, ["t-root"]);
  // Muting again is idempotent.
  res = await json(await request(path, { method: "POST", token: agentKey, data: { threadId: "t-root", muted: true } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.muted, true);
  // Another member's list is unaffected.
  res = await json(await request(path, { token: mayaKey }));
  assert.deepEqual(res.body.threadIds, []);
  // Unmute removes the row.
  res = await json(await request(path, { method: "POST", token: agentKey, data: { threadId: "t-root", muted: false } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.muted, false);
  res = await json(await request(path, { token: agentKey }));
  assert.deepEqual(res.body.threadIds, []);
});

test("thread mutes: validation", async t => {
  const { request, json, send, mayaKey, agentKey } = await serve(t);
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "v-root", body: "Root" });
  const path = "/api/rooms/commons/thread-mutes";
  for (const data of [{}, { threadId: "v-root" }, { muted: true }, { threadId: "v-root", muted: "yes" }, { threadId: "", muted: true }, { threadId: "v-root", muted: true, extra: 1 }]) {
    const res = await json(await request(path, { method: "POST", token: agentKey, data }));
    assert.equal(res.status, 422, `422 for ${JSON.stringify(data)}`);
    assert.equal(res.body.error.code, "invalid_thread_mute");
  }
  const missing = await json(await request(path, { method: "POST", token: agentKey, data: { threadId: "nope", muted: true } }));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "message_not_found");
  const unauth = await json(await request(path));
  assert.equal(unauth.status, 401);
});

test("muted threads are skipped in the notification feed and unread count", async t => {
  const { send, ownerKey, mayaKey, agentKey, store } = await serve(t);
  send(agentKey, T.MESSAGE_POSTED, { messageId: "feed-root", body: "Thread root" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "feed-reply", body: "Reply for @Test agent", replyToId: "feed-root" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "feed-other", body: "Unrelated @Test agent note" });
  const state = () => store.room("commons").state;
  const member = { id: "agent", displayName: "Test agent" };
  const rows = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='commons' ORDER BY sequence")
    .all().map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  const ids = items => items.map(i => i.messageId);
  const before = deriveNotifications({ events: rows, state: state(), member });
  assert.ok(ids(before).includes("feed-reply"), `baseline has the thread reply: ${ids(before)}`);
  assert.ok(ids(before).includes("feed-other"), `baseline has the other message: ${ids(before)}`);
  const muted = new Set(["feed-root"]);
  const during = deriveNotifications({ events: rows, state: state(), member, mutedThreadIds: muted });
  assert.ok(!ids(during).includes("feed-reply"), `muted thread hidden: ${ids(during)}`);
  assert.ok(ids(during).includes("feed-other"), "other threads unaffected");
  const after = deriveNotifications({ events: rows, state: state(), member, mutedThreadIds: new Set() });
  assert.deepEqual(ids(after), ids(before), "unmuting restores the items");
});

test("muted threads are skipped in the served notifications feed", async t => {
  const { request, json, send, mayaKey, agentKey } = await serve(t);
  send(agentKey, T.MESSAGE_POSTED, { messageId: "srv-root", body: "Thread root" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "srv-reply", body: "Reply for @Test agent", replyToId: "srv-root" });
  const mutes = "/api/rooms/commons/thread-mutes";
  let feed = await json(await request("/api/rooms/commons/notifications", { token: agentKey }));
  assert.equal(feed.status, 200);
  const unreadBefore = feed.body.unread;
  assert.ok(feed.body.notifications.some(n => n.messageId === "srv-reply"), "reply is unread before muting");
  const mute = await json(await request(mutes, { method: "POST", token: agentKey, data: { threadId: "srv-root", muted: true } }));
  assert.equal(mute.status, 200);
  feed = await json(await request("/api/rooms/commons/notifications", { token: agentKey }));
  assert.equal(feed.status, 200);
  assert.ok(!feed.body.notifications.some(n => n.messageId === "srv-reply"), "reply is hidden after muting");
  assert.equal(feed.body.unread, unreadBefore - 1, "unread count drops");
  const unmute = await json(await request(mutes, { method: "POST", token: agentKey, data: { threadId: "srv-root", muted: false } }));
  assert.equal(unmute.status, 200);
  feed = await json(await request("/api/rooms/commons/notifications", { token: agentKey }));
  assert.ok(feed.body.notifications.some(n => n.messageId === "srv-reply"), "reply returns after unmuting");
  assert.equal(feed.body.unread, unreadBefore);
});
