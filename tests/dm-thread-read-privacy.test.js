// CH-2011: DM thread read privacy.
//
// PR #2011 stopped non-parties from *replying* into a DM thread, but a
// party's reply posted without its own toMemberId (the natural thread
// continuation, e.g. the PR's own dm-r1) was served to the whole room on
// every read surface — snapshot, events, search, /thread, conversation,
// MCP event reads, notifications — and its replyToId confirmed the DM id
// the refusal was built to protect. Live admission now stamps such replies
// with the thread's other party, so the existing per-message DM visibility
// keeps non-participants (including the room owner) out of the thread.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const DM_BODY = "ch2011-dm-secret";
const REPLY_BODY = "ch2011-thread-reply-secret";

function storeFixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dm-thread-read-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const memberId of ["alice", "bob", "mallory"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: [] } });
  }
  const key = id => store.issueAccessKey("commons", id);
  const post = (id, data) => store.command(key(id), "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data });
  return { store, dir, post, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("admission stamps a DM thread reply with the thread's other party", () => {
  const f = storeFixture();
  try {
    f.post("alice", { messageId: "dm", body: DM_BODY, toMemberId: "bob" });
    f.post("bob", { messageId: "dm-r1", body: REPLY_BODY, replyToId: "dm" });
    const byId = new Map(f.store.room("commons").state.messages.map(m => [m.id, m]));
    assert.equal(byId.get("dm-r1").toMemberId, "alice", "recipient's reply is addressed to the DM author");
    f.post("alice", { messageId: "dm-r2", body: "back", replyToId: "dm-r1" });
    const again = new Map(f.store.room("commons").state.messages.map(m => [m.id, m]));
    assert.equal(again.get("dm-r2").toMemberId, "bob", "author's reply to the continuation is addressed to the recipient");
    // The stamp is a no-op for everyone else: public threads stay public.
    f.post("alice", { messageId: "pub", body: "public" });
    f.post("mallory", { messageId: "pub-r", body: "public reply", replyToId: "pub" });
    const pub = new Map(f.store.room("commons").state.messages.map(m => [m.id, m]));
    assert.equal(pub.get("pub-r").toMemberId ?? null, null);
  } finally { f.close(); }
});

test("an explicit toMemberId on a thread reply is the author's choice and is kept", () => {
  const f = storeFixture();
  try {
    f.post("alice", { messageId: "dm", body: DM_BODY, toMemberId: "bob" });
    f.post("bob", { messageId: "dm-r1", body: "explicit", replyToId: "dm", toMemberId: "alice" });
    const byId = new Map(f.store.room("commons").state.messages.map(m => [m.id, m]));
    assert.equal(byId.get("dm-r1").toMemberId, "alice");
  } finally { f.close(); }
});

test("a non-party still cannot reply into the thread (PR #2011 behavior intact)", () => {
  const f = storeFixture();
  try {
    f.post("alice", { messageId: "dm", body: DM_BODY, toMemberId: "bob" });
    assert.throws(() => f.post("mallory", { messageId: "x", body: "x", replyToId: "dm" }),
      err => err.code === "command_rejected");
  } finally { f.close(); }
});

async function httpFixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, key) => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return { ...f, origin, get };
}

async function seed(t) {
  const f = await httpFixture(t);
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  f.store.dmConsents.request("commons", "producer", "reviewer", "ch-2011");
  f.store.dmConsents.decide("commons", "reviewer", "producer", "approve");
  send("producer", T.MESSAGE_POSTED, { messageId: "dm-a", body: DM_BODY, toMemberId: "reviewer" });
  // Natural thread continuations: no toMemberId, like PR #2011's own dm-r1.
  send("reviewer", T.MESSAGE_POSTED, { messageId: "dm-a-r1", body: REPLY_BODY, replyToId: "dm-a" });
  send("producer", T.MESSAGE_POSTED, { messageId: "dm-a-r2", body: `second ${REPLY_BODY}`, replyToId: "dm-a-r1" });
  // A mention of a bystander inside the thread must not pull them in.
  send("reviewer", T.MESSAGE_POSTED, { messageId: "dm-a-r3", body: "@Test guest see this?", replyToId: "dm-a-r2" });
  return f;
}

test("non-participants see no DM thread content on any read surface", async t => {
  const f = await seed(t);
  for (const [label, key] of [["guest", f.keys.guest], ["owner", f.keys.owner]]) {
    const snapshot = await f.get("/api/rooms/commons", key).then(r => r.json());
    const snapText = JSON.stringify(snapshot);
    assert.equal(snapText.includes(REPLY_BODY), false, `${label}: snapshot must not carry thread reply bodies`);
    assert.equal(snapText.includes("dm-a-r1"), false, `${label}: snapshot must not carry thread reply ids`);

    const search = await f.get(`/api/rooms/commons/search?q=${encodeURIComponent("ch2011-thread-reply")}`, key).then(r => r.json());
    assert.deepEqual(search.messages, [], `${label}: search must not surface thread replies`);

    const threadRes = await f.get("/api/rooms/commons/messages/dm-a-r1/thread", key);
    assert.equal(threadRes.status, 404, `${label}: thread route on a reply must 404 like a missing message`);

    const events = await f.get("/api/rooms/commons/events?after=0&limit=200", key).then(r => r.json());
    assert.equal(JSON.stringify(events).includes(REPLY_BODY), false, `${label}: events must not carry thread reply bodies`);

    const convo = await f.get("/api/rooms/commons/conversation?messageId=dm-a-r1", key);
    assert.equal(convo.status, 404, `${label}: conversation read of a reply must 404`);

    const notifications = await f.get("/api/rooms/commons/notifications", key).then(r => r.json());
    assert.ok(notifications.notifications.every(item => item.messageId !== "dm-a-r3"),
      `${label}: being named inside a DM thread is not a mention of you`);
  }
});

test("parties keep full read access to the DM thread", async t => {
  const f = await seed(t);
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer]]) {
    const snapshot = await f.get("/api/rooms/commons", key).then(r => r.json());
    assert.ok(JSON.stringify(snapshot).includes(REPLY_BODY), `${label} should see thread replies`);
    const res = await f.get("/api/rooms/commons/messages/dm-a-r1/thread", key);
    assert.equal(res.status, 200, `${label} should read the thread`);
    const search = await f.get(`/api/rooms/commons/search?q=${encodeURIComponent("ch2011-thread-reply")}`, key).then(r => r.json());
    assert.ok(search.messages.length >= 2, `${label} should find thread replies via search`);
  }
  // The recipient is still notified about the thread reply (reply relation).
  const reviewer = await f.get("/api/rooms/commons/notifications", f.keys.reviewer).then(r => r.json());
  assert.ok(reviewer.notifications.some(item => item.messageId === "dm-a"),
    "the DM recipient still gets their DM notification");
});

test("reply-request threads stay room-visible: comments under them are not stamped", async t => {
  const f = await httpFixture(t);
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  f.store.dmConsents.request("commons", "producer", "reviewer", "ch-2011");
  f.store.dmConsents.decide("commons", "reviewer", "producer", "approve");
  send("producer", T.MESSAGE_POSTED, { messageId: "req-1", body: "Which option?", toMemberId: "reviewer",
    requestKind: "reply" });
  // A non-party may clarify under a reply request (PR #2011 exemption).
  send("guest", T.MESSAGE_POSTED, { messageId: "req-1-c", body: "clarifying comment", replyToId: "req-1" });
  const byId = new Map(f.store.room("commons").state.messages.map(m => [m.id, m]));
  assert.equal(byId.get("req-1-c").toMemberId ?? null, null, "room-threaded reply-request comments stay public");
  const ownerSnap = await f.get("/api/rooms/commons", f.keys.owner).then(r => r.json());
  assert.ok(ownerSnap.state.messages.some(m => m.id === "req-1-c" && m.body === "clarifying comment"),
    "the room still sees clarifying comments under reply requests");
});
