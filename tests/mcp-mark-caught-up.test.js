// room_mark_caught_up: an MCP-only agent saves its own catch-up marker, so a
// later cold room_read_messages returns the #5819 catchUp hint.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { callHostedStdioTool, validHostedStdioArgs } from "../server/mcp-full-profile.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  store.command(keys.owner, "commons", { id: "join-w", type: "member.added",
    data: { memberId: "worker1", displayName: "Worker 1", kind: "agent", permissions: [] } });
  keys.worker1 = store.issueAccessKey("commons", "worker1");
  const post = messageId => store.command(keys.owner, "commons",
    { id: `post-${messageId}`, type: "message.posted", data: { messageId, body: messageId } });
  const call = (name, args) => callHostedStdioTool(store, keys.worker1, name, { roomId: "commons", ...args });
  const marker = () => store.db.prepare("SELECT sequence FROM cursors WHERE room_id='commons' AND member_id='worker1'").get()?.sequence;
  return { store, post, call, marker };
}

test("mark then cold read: the hint points at the saved marker and the follow-up read is only new messages", async t => {
  const f = fixture(t);
  for (const id of ["old-1", "old-2"]) f.post(id);
  assert.equal((await f.call("room_read_messages", { limit: 2 })).value.catchUp, undefined, "no marker, no hint");
  const handled = (await f.call("room_read_messages", { after: 0 })).value.next;
  const saved = await f.call("room_mark_caught_up", { sequence: handled });
  assert.equal(saved.isError, false);
  assert.equal(saved.value.cursor, handled);
  f.post("new-1");
  const cold = (await f.call("room_read_messages", { limit: 2 })).value;
  assert.equal(cold.catchUp.after, handled);
  const next = (await f.call("room_read_messages", cold.catchUp.nextRead.arguments)).value;
  assert.deepEqual(next.messages.map(m => m.messageId), ["new-1"]);
});

test("the marker never rewinds, and an out-of-range or malformed sequence is refused", async t => {
  const f = fixture(t);
  for (const id of ["a", "b", "c"]) f.post(id);
  const head = f.store.room("commons").sequence;
  await f.call("room_mark_caught_up", { sequence: head });
  const lower = await f.call("room_mark_caught_up", { sequence: 1 });
  assert.equal(lower.value.cursor, head, "lower sequence leaves the marker");
  assert.equal(f.marker(), head);
  await assert.rejects(f.call("room_mark_caught_up", { sequence: head + 100 }), error => error.status === 422 && error.code === "invalid_cursor");
  assert.equal(f.marker(), head);
  assert.equal(validHostedStdioArgs("room_mark_caught_up", { roomId: "commons", sequence: -1 }), false);
  assert.equal(validHostedStdioArgs("room_mark_caught_up", { roomId: "commons", sequence: 1.5 }), false);
  assert.equal(validHostedStdioArgs("room_mark_caught_up", { roomId: "commons" }), false);
  assert.equal(validHostedStdioArgs("room_mark_caught_up", { roomId: "commons", sequence: 2 }), true);
});

test("marking posts nothing and changes no work", async t => {
  const f = fixture(t);
  f.post("a");
  const before = f.store.room("commons").sequence;
  await f.call("room_mark_caught_up", { sequence: before });
  assert.equal(f.store.room("commons").sequence, before, "no room event appended");
});

// Review asks from lobby seq 278: room and member binding, the since_join
// floor, an incomplete page, and an own marker never resolving earlier work.
test("the marker binds to the caller's room and member only", async t => {
  const f = fixture(t);
  for (const id of ["a", "b"]) f.post(id);
  const head = f.store.room("commons").sequence;
  await assert.rejects(f.call("room_mark_caught_up", { roomId: "not-joined", sequence: 1 }), error => error.status >= 400);
  await f.call("room_mark_caught_up", { sequence: head });
  const ownerMarker = f.store.db.prepare("SELECT sequence FROM cursors WHERE room_id='commons' AND member_id='owner'").get()?.sequence;
  assert.notEqual(ownerMarker, head, "another member's marker is untouched");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM cursors WHERE room_id='not-joined'").get().n, 0);
});

test("since_join: a marker below the floor never exposes the hidden prefix", async t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: "vis", type: "room.history_visibility_set", data: { historyVisibility: "since_join" } });
  store.command(owner, "commons", { id: "p-secret", type: "message.posted", data: { messageId: "before-join", body: "PRE-JOIN" } });
  store.command(owner, "commons", { id: "join-late", type: "member.added", data: { memberId: "late", displayName: "Late", kind: "agent", permissions: [] } });
  const late = store.issueAccessKey("commons", "late");
  store.command(owner, "commons", { id: "p-after", type: "message.posted", data: { messageId: "after-join", body: "visible" } });
  const call = (name, args) => callHostedStdioTool(store, late, name, { roomId: "commons", ...args });
  await call("room_mark_caught_up", { sequence: 1 });
  const cold = (await call("room_read_messages", { limit: 1 })).value;
  const floor = store.historyFloor("commons", "late").sequence;
  assert.ok(cold.catchUp.after >= floor - 1, "hint clamps to the floor");
  const next = (await call("room_read_messages", cold.catchUp.nextRead.arguments)).value;
  assert.ok(!JSON.stringify(next).includes("PRE-JOIN"));
  assert.ok(next.messages.some(m => m.messageId === "after-join"));
});

test("marking the end of an incomplete page resumes at the rest of the page", async t => {
  const f = fixture(t);
  for (const id of ["p1", "p2", "p3"]) f.post(id);
  const first = (await f.call("room_read_messages", { after: 0, limit: 1 })).value;
  assert.equal(first.hasMore, true);
  await f.call("room_mark_caught_up", { sequence: first.next });
  const cold = (await f.call("room_read_messages", { limit: 1 })).value;
  assert.equal(cold.catchUp.after, first.next, "hint is the page end, not the room head");
  const rest = (await f.call("room_read_messages", cold.catchUp.nextRead.arguments)).value;
  const ids = rest.messages.map(m => m.messageId);
  assert.ok(!ids.includes("p1"), "the handled page is not re-read");
  assert.ok(ids.includes("p2") && ids.includes("p3"), "the unread rest of the page is not skipped");
});

test("an own marker does not resolve an earlier open formal request", async t => {
  const f = fixture(t);
  f.store.command(f.store.issueAccessKey("commons", "owner"), "commons", { id: "ask", type: "message.posted",
    data: { messageId: "ask", body: "please answer", toMemberId: "worker1", requestKind: "reply" } });
  const head = f.store.room("commons").sequence;
  await f.call("room_mark_caught_up", { sequence: head });
  const open = (await f.call("room_list_requests", { direction: "incoming", status: "open" })).value;
  assert.ok(open.requests.some(r => r.id === "ask"), "request stays open after marking past it");
});
