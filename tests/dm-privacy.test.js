// RC-2026-09-19-070: DMs are fully private to the two parties. The
// sender+recipient-only filter is enforced at the HTTP layer on all four
// read surfaces — the room snapshot (state.eventLog AND state.messages),
// /search, /messages/:id/thread, and /work-discussion — so non-participants
// (including the room owner) see no DM existence, count, or metadata.
// The /export event walk carries the same filter as the /events route.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const DM_BODY = "dm-secret-alpha-7q";
const DM_WORK_BODY = "dm-work-secret-9r";
const DM_REPLY_BODY = "dm-reply-secret-4t";
const PUBLIC_BODY = "public-hello-beta-3z";

async function fixture(t) {
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

// producer -> reviewer DM; guest is a bystander, owner is the room owner
// (non-participant on purpose — the owner is not exempt from the filter).
async function seed(t) {
  const f = await fixture(t);
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  // Consent-bound DMs: the producer's DMs to the reviewer need the
  // reviewer's approval first.
  f.store.dmConsents.request("commons", "producer", "reviewer", "test fixture");
  f.store.dmConsents.decide("commons", "reviewer", "producer", "approve");
  send("producer", T.MESSAGE_POSTED, { messageId: "dm-1", body: DM_BODY, toMemberId: "reviewer" });
  send("producer", T.MESSAGE_POSTED, { messageId: "dm-work-1", body: DM_WORK_BODY, toMemberId: "reviewer", workItemId: "test-handoff" });
  send("owner", T.MESSAGE_POSTED, { messageId: "thread-root", body: "a public thread root" });
  send("producer", T.MESSAGE_POSTED, { messageId: "thread-dm-reply", body: DM_REPLY_BODY, toMemberId: "reviewer", replyToId: "thread-root" });
  send("owner", T.MESSAGE_POSTED, { messageId: "public-1", body: PUBLIC_BODY });
  send("owner", T.MESSAGE_POSTED, { messageId: "public-work-1", body: "public work note gamma-5w", workItemId: "test-handoff" });
  return f;
}

const snapshotHasDm = snapshot =>
  (snapshot.state.messages ?? []).some(m => m.id === "dm-1")
  || (snapshot.state.eventLog ?? []).some(e => e?.data?.messageId === "dm-1");

test("snapshot: participants see the DM in messages and the event log", async t => {
  const f = await seed(t);
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer]]) {
    const res = await f.get("/api/rooms/commons", key);
    assert.equal(res.status, 200);
    const snapshot = await res.json();
    assert.ok(snapshotHasDm(snapshot), `${label} should see the DM`);
    assert.equal(snapshot.state.messages.find(m => m.id === "dm-1").body, DM_BODY);
    assert.ok(snapshot.state.eventLog.some(e => e?.data?.messageId === "dm-1" && e.data.body === DM_BODY),
      `${label} should see the DM event in the audit tail`);
  }
});

test("snapshot: non-participants and the room owner see no DM existence, count, or metadata", async t => {
  const f = await seed(t);
  for (const [label, key] of [["guest", f.keys.guest], ["owner", f.keys.owner]]) {
    const res = await f.get("/api/rooms/commons", key);
    assert.equal(res.status, 200);
    const snapshot = await res.json();
    assert.equal(snapshotHasDm(snapshot), false, `${label} must not see the DM`);
    assert.equal(JSON.stringify(snapshot).includes(DM_BODY), false, `${label} must not see the DM body anywhere`);
    assert.equal(JSON.stringify(snapshot).includes(DM_WORK_BODY), false, `${label} must not see the work DM body anywhere`);
    // Sanity: public traffic is unaffected.
    assert.ok(snapshot.state.messages.some(m => m.id === "public-1" && m.body === PUBLIC_BODY),
      `${label} should still see public messages`);
  }
});

test("search: participants find the DM, non-participants and the owner do not", async t => {
  const f = await seed(t);
  const search = (key, q) => f.get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}`, key).then(r => r.json());
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer]]) {
    const result = await search(key, DM_BODY);
    assert.equal(result.messages.length, 1, `${label} should find the DM`);
    assert.equal(result.messages[0].body, DM_BODY);
  }
  for (const [label, key] of [["guest", f.keys.guest], ["owner", f.keys.owner]]) {
    const result = await search(key, DM_BODY);
    assert.deepEqual(result.messages, [], `${label} must not find the DM`);
    const publicResult = await search(key, PUBLIC_BODY);
    assert.equal(publicResult.messages.length, 1, `${label} should still find public messages`);
  }
});

test("thread: participants read the DM thread, non-participants get 404", async t => {
  const f = await seed(t);
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer]]) {
    const res = await f.get("/api/rooms/commons/messages/dm-1/thread", key);
    assert.equal(res.status, 200, `${label} should read the DM thread`);
    const value = await res.json();
    assert.equal(value.thread.body, DM_BODY);
  }
  for (const [label, key] of [["guest", f.keys.guest], ["owner", f.keys.owner]]) {
    const res = await f.get("/api/rooms/commons/messages/dm-1/thread", key);
    assert.equal(res.status, 404, `${label} must get 404 for the DM thread`);
    const value = await res.json();
    assert.equal(value.error?.code, "message_not_found");
  }
});

test("thread: DM replies are stripped from a visible thread for non-participants", async t => {
  const f = await seed(t);
  const guestRes = await f.get("/api/rooms/commons/messages/thread-root/thread", f.keys.guest);
  assert.equal(guestRes.status, 200);
  const guestThread = (await guestRes.json()).thread;
  assert.equal(guestThread.body, "a public thread root");
  assert.deepEqual(guestThread.replies, [], "guest must not see the DM reply");
  assert.equal(JSON.stringify(guestThread).includes(DM_REPLY_BODY), false);
  const reviewerRes = await f.get("/api/rooms/commons/messages/thread-root/thread", f.keys.reviewer);
  assert.equal(reviewerRes.status, 200);
  const reviewerThread = (await reviewerRes.json()).thread;
  assert.equal(reviewerThread.replies.length, 1, "the recipient sees the DM reply");
  assert.equal(reviewerThread.replies[0].body, DM_REPLY_BODY);
});

test("work-discussion: participants see the DM, non-participants do not — and the roster leaks nothing", async t => {
  const f = await seed(t);
  const discussion = key => f.get("/api/rooms/commons/work-discussion?workItemId=test-handoff", key).then(r => r.json());
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer]]) {
    const value = await discussion(key);
    const ids = value.discussion.items.map(item => item.message.id);
    assert.ok(ids.includes("dm-work-1"), `${label} should see the DM in the discussion`);
    assert.equal(value.discussion.items.find(item => item.message.id === "dm-work-1").message.body, DM_WORK_BODY);
  }
  for (const [label, key] of [["guest", f.keys.guest], ["owner", f.keys.owner]]) {
    const value = await discussion(key);
    const ids = value.discussion.items.map(item => item.message.id);
    assert.equal(ids.includes("dm-work-1"), false, `${label} must not see the DM in the discussion`);
    assert.equal(JSON.stringify(value).includes(DM_WORK_BODY), false, `${label} must not see the DM body`);
    // The participant roster is rebuilt from the visible items only: the DM
    // parties must not appear via the filtered DM.
    assert.equal(value.current.participants.some(p => p.id === "reviewer"), false,
      `${label} must not learn the DM recipient from the roster`);
  }
});

test("work-discussion pagination: page boundaries reveal no hidden DMs", async t => {
  const f = await seed(t);
  // Guest pages with limit=1 through a discussion whose linked DM sits
  // between two public messages. Every page must be DM-free and the walk
  // must terminate cleanly with the full visible set.
  const seen = [];
  let cursor = null, guard = 0;
  for (;;) {
    const params = new URLSearchParams({ workItemId: "test-handoff", limit: "1" });
    if (cursor) params.set("cursor", cursor);
    const value = await f.get(`/api/rooms/commons/work-discussion?${params}`, f.keys.guest).then(r => r.json());
    assert.equal(JSON.stringify(value).includes(DM_WORK_BODY), false, "no page may carry the DM");
    for (const item of value.discussion.items) seen.push(item.message.id);
    if (!value.discussion.hasMore) break;
    cursor = value.discussion.nextCursor;
    assert.ok(cursor, "hasMore=true must come with a continuation");
    assert.ok(++guard < 10, "pagination must terminate");
  }
  assert.deepEqual(seen, ["test-request", "public-work-1"]);
});

test("pins: a pinned DM is invisible to non-participants on /pins and in the snapshot", async t => {
  const f = await seed(t);
  const post = (key, data) => fetch(`${f.origin}/api/rooms/commons/pins`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(data) }).then(r => r.json());
  // A participant pins the DM and a public message.
  await post(f.keys.producer, { messageId: "dm-1", pinned: true });
  await post(f.keys.owner, { messageId: "public-1", pinned: true });
  for (const [label, key] of [["producer", f.keys.producer], ["reviewer", f.keys.reviewer]]) {
    const value = await f.get("/api/rooms/commons/pins", key).then(r => r.json());
    assert.equal(value.count, 2, `${label} sees both pins`);
    assert.ok(value.pins.some(pin => pin.messageId === "dm-1" && pin.body === DM_BODY),
      `${label} sees the pinned DM body`);
  }
  for (const [label, key] of [["guest", f.keys.guest], ["owner", f.keys.owner]]) {
    const value = await f.get("/api/rooms/commons/pins", key).then(r => r.json());
    assert.equal(value.count, 1, `${label} sees only the public pin`);
    assert.ok(value.pins.every(pin => pin.messageId !== "dm-1"), `${label} must not see the DM pin`);
    assert.equal(JSON.stringify(value).includes(DM_BODY), false, `${label} must not see the DM body via pins`);
    const snapshot = await f.get("/api/rooms/commons", key).then(r => r.json());
    assert.ok((snapshot.state.pins ?? []).every(pin => pin.messageId !== "dm-1"),
      `${label} must not see the DM pin in the snapshot`);
  }
});

test("export: non-participants get no DM events in the JSONL export", async t => {
  const f = await seed(t);
  const res = await f.get("/api/rooms/commons/export", f.keys.guest);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(DM_BODY), false, "guest must not see the DM body in the export");
  assert.equal(text.includes(DM_WORK_BODY), false, "guest must not see the work DM body in the export");
  assert.ok(text.includes(PUBLIC_BODY), "public messages stay in the export");
  const ownerExport = await f.get("/api/rooms/commons/export?format=html", f.keys.owner);
  assert.equal(ownerExport.status, 200);
  assert.equal((await ownerExport.text()).includes(DM_BODY), false, "the owner must not see the DM body in the HTML export");
});

// The notification feed was the one read surface the filter above never
// reached. It derives its own items from the raw event tail rather than going
// through the snapshot or store.eventsAfter, so a DM that happened to reply to
// a public message put a "reply" item in the parent author's feed: existence,
// author, timestamp, message id and a bump to their unread count, for a
// conversation they are not part of.
test("notifications: a DM replying to my public message is not my notification", async t => {
  const f = await seed(t);
  // The owner wrote thread-root; producer's DM to reviewer replies to it.
  const owner = await f.get("/api/rooms/commons/notifications", f.keys.owner).then(r => r.json());
  assert.ok(owner.notifications.every(item => item.messageId !== "thread-dm-reply"),
    "the owner must not learn a DM exists by being the parent author");
  assert.equal(JSON.stringify(owner).includes(DM_REPLY_BODY), false, "and certainly not its body");

  // The guest is a plain bystander and must see none of the three DMs.
  const guest = await f.get("/api/rooms/commons/notifications", f.keys.guest).then(r => r.json());
  for (const messageId of ["dm-1", "dm-work-1", "thread-dm-reply"]) {
    assert.ok(guest.notifications.every(item => item.messageId !== messageId), `guest must not see ${messageId}`);
  }

  // The filter must not cost the recipient their own notification.
  const reviewer = await f.get("/api/rooms/commons/notifications", f.keys.reviewer).then(r => r.json());
  assert.ok(reviewer.notifications.some(item => item.messageId === "dm-1"),
    "the member the DM was sent to is still told about it");
});

test("notifications: an @mention inside a DM does not notify the person named", async t => {
  const f = await seed(t);
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  // Naming someone in a message they cannot read must not reach them: it would
  // be a way to signal any member from a conversation they have no access to.
  send("producer", T.MESSAGE_POSTED, { messageId: "dm-naming-guest", body: `@Test guest ${DM_BODY}`, toMemberId: "reviewer" });

  const guest = await f.get("/api/rooms/commons/notifications", f.keys.guest).then(r => r.json());
  assert.ok(guest.notifications.every(item => item.messageId !== "dm-naming-guest"),
    "being named in a DM between two other people is not a mention of you");
});
