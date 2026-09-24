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
import { setTier } from "../server/autonomy-tiers.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-search-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const post = (body, extra = {}) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body, ...extra } }).event.data.messageId;
  const propose = (title) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: randomUUID(), title, definitionOfDone: "done when done", accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } });
  const remove = (messageId) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_DELETED, data: { messageId, expectedMessageRevision: 0, reason: "test" } });
  return { origin, store, ownerKey, get, post, propose, remove };
}

test("full-text search over messages and work (round-2 #113)", async t => {
  const { ownerKey, get, post, propose, remove } = await serve(t);
  const keepId = post("The quick brown fox jumps");
  post("something unrelated here");
  const doomed = post("fox in the henhouse");
  propose("Fix the fox widget");

  // Deleted messages are tombstones and must not match.
  remove(doomed);

  const search = async (q, kind) => {
    const res = await get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`, ownerKey);
    assert.equal(res.status, 200);
    return res.json();
  };

  let r = await search("fox");
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].id, keepId);
  assert.equal(r.workItems.length, 1);
  assert.equal(r.workItems[0].title, "Fix the fox widget");

  r = await search("fox", "messages");
  assert.equal(r.messages.length, 1);
  assert.equal(r.workItems.length, 0);

  r = await search("fox", "work");
  assert.equal(r.messages.length, 0);
  assert.equal(r.workItems.length, 1);

  // Case-insensitive.
  r = await search("FOX", "messages");
  assert.equal(r.messages.length, 1);

  // Surrounding whitespace is ignored, matching the echoed trimmed query.
  r = await search("  jumps ", "messages");
  assert.equal(r.query, "jumps");
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].id, keepId);

  // Bad input rejected.
  assert.equal((await get("/api/rooms/commons/search", ownerKey)).status, 422);
  assert.equal((await get("/api/rooms/commons/search?q=x&kind=bogus", ownerKey)).status, 422);
  // Non-members get 401.
  assert.equal((await get("/api/rooms/commons/search?q=fox")).status, 401);
});

// Backlog 11: a muted author's messages are excluded server-side for every kind,
// mirroring the browser's isMutedBy filter (E4 moderation, docs/MODERATION.md).
test("search skips a muted author's messages for the muter only, across kind=all and kind=messages", async t => {
  const { store, ownerKey, get, post, propose } = await serve(t);
  const keys = { owner: ownerKey };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const [memberId, kind, permissions] of [["guest", "human", []], ["producer", "agent", ["accept_work"]]]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind, permissions, ...(kind === "agent" ? { accountableHumanId: "owner" } : {}) });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  // #953: new agent members default to t1_readonly; producer needs write access for message.posted
  setTier(store.db, "commons", "producer", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const search = async (q, kind, actor) => {
    const res = await get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`, keys[actor]);
    assert.equal(res.status, 200);
    return res.json();
  };
  const ids = (r) => r.messages.map(m => m.id);

  const fromOwner = post("Meeting room is B-204 from Thursday");
  const fromProducer = send("producer", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "Meeting agenda from the producer" }).event.data.messageId;
  propose("Book the meeting room");

  // Before muting, the guest sees both messages under every kind, plus the work item where kind allows.
  for (const kind of [undefined, "all", "messages"]) assert.deepEqual(ids(await search("meeting", kind, "guest")), [fromOwner, fromProducer]);
  assert.equal((await search("meeting", "all", "guest")).workItems.length, 1);

  // The guest mutes the producer: the producer's message drops out for the guest under kind=all, default and kind=messages.
  send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true });
  for (const kind of [undefined, "all", "messages"]) assert.deepEqual(ids(await search("meeting", kind, "guest")), [fromOwner], `kind=${kind}`);
  // Work is never filtered by mute (work has no author), and the count stays.
  const all = await search("meeting", "all", "guest");
  assert.equal(all.workItems.length, 1);
  assert.deepEqual(ids(await search("meeting", "work", "guest")), []);
  assert.equal((await search("meeting", "work", "guest")).workItems.length, 1);
  // A query matching only the muted author's message is simply empty, not an error.
  assert.deepEqual(await search("agenda", "messages", "guest"), { roomId: "commons", query: "agenda", messages: [], workItems: [] });

  // Nobody else is affected: the owner and the muted producer still see everything.
  assert.deepEqual(ids(await search("meeting", "all", "owner")), [fromOwner, fromProducer]);
  assert.deepEqual(ids(await search("meeting", "messages", "producer")), [fromOwner, fromProducer]);
  // Muting is one-directional: the producer's own search is not affected by being muted.
  assert.deepEqual(ids(await search("agenda", "all", "producer")), [fromProducer]);

  // Unmute restores the results immediately.
  send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: false });
  assert.deepEqual(ids(await search("meeting", "all", "guest")), [fromOwner, fromProducer]);
});

// Backlog follow-up 8: kind=pinned narrows search to state.pins (issue #6 B2).
test("kind=pinned searches only pinned messages, follows unpin, and hides a muted author's pin from the muter", async t => {
  const { store, ownerKey, get, post, propose, remove } = await serve(t);
  const keys = { owner: ownerKey };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const [memberId, kind, permissions] of [["guest", "human", []], ["producer", "agent", ["accept_work"]]]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind, permissions, ...(kind === "agent" ? { accountableHumanId: "owner" } : {}) });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  // #953: new agent members default to t1_readonly; producer needs write access for message.posted
  setTier(store.db, "commons", "producer", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const pin = (actor, messageId, pinned) => send(actor, pinned ? T.MESSAGE_PINNED : T.MESSAGE_UNPINNED, { messageId });
  const search = async (q, kind, actor = "owner") => {
    const res = await get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}&kind=${kind}`, keys[actor]);
    assert.equal(res.status, 200);
    return res.json();
  };

  const first = post("Meeting room is B-204 from Thursday");
  const second = post("Meeting notes are in the shared folder");
  post("Parking code is 4411");
  propose("Book the meeting room");

  // Nothing pinned yet: the plain search finds both messages; the pinned search finds nothing, and never work.
  assert.equal((await search("meeting", "messages")).messages.length, 2);
  assert.deepEqual(await search("meeting", "pinned"), { roomId: "commons", query: "meeting", messages: [], workItems: [] });

  pin("owner", second, true);
  pin("owner", first, true);
  // Message order is preserved (not pin order), the term still applies, work stays out.
  let r = await search("meeting", "pinned");
  assert.deepEqual(r.messages.map(m => m.id), [first, second]);
  assert.equal(r.workItems.length, 0);
  assert.deepEqual((await search("4411", "pinned")).messages, [], "an unpinned match stays out");
  assert.equal((await search("4411", "messages")).messages.length, 1, "the other kinds are untouched");
  assert.equal((await search("MEETING", "pinned")).messages.length, 2, "case-insensitive like the other kinds");

  // Unpin removes it from the pinned search only.
  pin("owner", first, false);
  assert.deepEqual((await search("meeting", "pinned")).messages.map(m => m.id), [second]);
  assert.equal((await search("meeting", "messages")).messages.length, 2);

  // A muted author's pinned message stays hidden for the muter and visible to everyone else.
  const fromProducer = send("producer", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "Meeting agenda from the producer" }).event.data.messageId;
  pin("producer", fromProducer, true);
  assert.deepEqual((await search("meeting", "pinned", "guest")).messages.map(m => m.id), [second, fromProducer]);
  send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true });
  assert.deepEqual((await search("meeting", "pinned", "guest")).messages.map(m => m.id), [second], "the muter does not see the muted author's pin");
  assert.deepEqual((await search("meeting", "pinned", "owner")).messages.map(m => m.id), [second, fromProducer], "other members still do");

  // A deleted pinned message drops out (the reducer drops its pin; the body is a tombstone either way).
  remove(second);
  assert.deepEqual((await search("meeting", "pinned")).messages.map(m => m.id), [fromProducer]);
});
