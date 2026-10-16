// B-4' Phase 0 slice 3b (Appendix D §D.1 §4.1 follow-through): the five
// server read paths that project the work brief now resolve
// definitionOfDone + mode BOARD-FIRST via the shared helper in
// server/work-item-board.mjs (boardRowForItem / briefForWorkItem), with
// item fallback — proposed items have no card, so the item is their
// only source, correct until Phase 2. Output shape is byte-identical:
// same keys, board value substituted when a row carries the field.
//
// Per surface this suite pins: output equality when row and item agree,
// board wins when they disagree, item fallback for a proposed item.
// The fifth surface, the room export (server/room-export-html.mjs), is
// NOT repointed: walkExport/renderRoomExportHtml are pure functions of
// the event log with no store access, the brief there comes from the
// work.proposed event payload (the origin of the item's stored value),
// and the HTML export renders no mode at all. It is named as a Phase-3
// exception in the slice-3b PR body rather than given invented plumbing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
import { boardRowForItem, briefForWorkItem } from "../server/work-item-board.mjs";
import { buildOpportunitiesFeed } from "../server/opportunities.mjs";
import { syncRoomPublication } from "../server/public-read-model.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workitems-brief-readers-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-worker", type: "member.added", data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] } });
  const workerKey = store.issueAccessKey("commons", "worker");
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const item = id => store.room("commons").state.workItems[id];
  const mutate = (key, id, type, workItemId, data = {}) => send(key, id, type, { workItemId, expectedRevision: item(workItemId).revision, ...data });
  const board = id => store.workClaims.get("commons", id);
  const diverge = (id, patch) => store.workClaims.set("commons", { ...board(id), ...patch });
  const propose = (id, dod, mode = "read") => send(ownerKey, `propose-${id}`, "work.proposed", { workItemId: id, title: `Task ${id}`, definitionOfDone: dod, accountableMemberId: "worker", mode });
  return { store, ownerKey, workerKey, send, item, mutate, board, diverge, propose };
}

test("slice3b helper: boardRowForItem + briefForWorkItem — board wins per carried field, item fallback otherwise", () => {
  const item = { id: "x1", definitionOfDone: "ITEM-DOD", mode: "read" };
  const row = { definitionOfDone: "BOARD-DOD", mode: "write" };
  const store = { workClaims: { get: (roomId, claimId) => (claimId === "x1" ? row : null) } };
  assert.equal(boardRowForItem(store, "commons", "x1"), row);
  assert.equal(boardRowForItem(store, "commons", "missing"), null);
  assert.equal(boardRowForItem(null, "commons", "x1"), null);
  assert.equal(boardRowForItem({}, "commons", "x1"), null);
  assert.deepEqual(briefForWorkItem(item, row), { definitionOfDone: "BOARD-DOD", mode: "write" });
  assert.deepEqual(briefForWorkItem(item, null), { definitionOfDone: "ITEM-DOD", mode: "read" });
  // A row carrying only one field wins only that field; null never erases.
  assert.deepEqual(briefForWorkItem(item, { definitionOfDone: "BOARD-DOD", mode: null }), { definitionOfDone: "BOARD-DOD", mode: "read" });
});

test("slice3b work-context: store.workContext + snapshot work view resolve the brief board-first", async (t) => {
  const f = fixture(t);
  f.propose("ctx-1", "ITEM-DOD", "read");
  f.mutate(f.workerKey, "accept", "work.accepted", "ctx-1");
  // Agree: row and item carry the same brief — output is the item's values.
  let ctx = f.store.workContext(f.ownerKey, "commons", "ctx-1");
  assert.equal(ctx.work.definitionOfDone, "ITEM-DOD");
  assert.equal(ctx.work.mode, "read");
  // Disagree: the board row wins, in both the selected read and the
  // snapshot work view (both thread through currentWorkRecord).
  f.diverge("ctx-1", { definitionOfDone: "BOARD-DOD", mode: "write" });
  ctx = f.store.workContext(f.ownerKey, "commons", "ctx-1");
  assert.equal(ctx.work.definitionOfDone, "BOARD-DOD");
  assert.equal(ctx.work.mode, "write");
  const snap = f.store.snapshot(f.ownerKey, "commons", null, "work");
  assert.equal(snap.state.workItems["ctx-1"].definitionOfDone, "BOARD-DOD");
  assert.equal(snap.state.workItems["ctx-1"].mode, "write");
  // Proposed item: no card exists — item fallback.
  f.propose("ctx-2", "PROPOSED-DOD", "write");
  assert.equal(f.board("ctx-2"), null);
  ctx = f.store.workContext(f.ownerKey, "commons", "ctx-2");
  assert.equal(ctx.work.definitionOfDone, "PROPOSED-DOD");
  assert.equal(ctx.work.mode, "write");
});

test("slice3b opportunities: the help-wanted feed resolves the brief board-first", async (t) => {
  const f = fixture(t);
  f.store.roomDirectory.set("commons", "owner", true);
  f.propose("opp-1", "ITEM-DOD", "read");
  f.mutate(f.workerKey, "accept", "work.accepted", "opp-1");
  f.send(f.workerKey, "help", "work.help_updated", { workItemId: "opp-1", expectedRevision: f.item("opp-1").revision, expectedHelpRevision: 0, status: "open", scope: "Need a hand", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  const feed = () => buildOpportunitiesFeed(f.store, { roomId: "commons" }).opportunities.find(o => o.workItemId === "opp-1");
  assert.equal(feed().definitionOfDone, "ITEM-DOD");
  assert.equal(feed().mode, "read");
  f.diverge("opp-1", { definitionOfDone: "BOARD-DOD", mode: "write" });
  assert.equal(feed().definitionOfDone, "BOARD-DOD");
  assert.equal(feed().mode, "write");
});

test("slice3b public-read-model: the public task list resolves definitionOfDone board-first, proposed items fall back", async (t) => {
  const f = fixture(t);
  f.propose("pub-1", "ITEM-DOD", "read");
  f.send(f.ownerKey, "publish-1", "work.public_set", { workItemId: "pub-1", enabled: true });
  f.mutate(f.workerKey, "accept", "work.accepted", "pub-1");
  f.propose("pub-2", "PROPOSED-DOD", "read");
  f.send(f.ownerKey, "publish-2", "work.public_set", { workItemId: "pub-2", enabled: true });
  f.send(f.ownerKey, "page-on", "room.public_page_set", { enabled: true });
  const tasks = () => JSON.parse(f.store.db.prepare("SELECT tasks_json FROM public_rooms WHERE slug='commons'").get().tasks_json);
  assert.deepEqual(tasks(), [
    { title: "Task pub-1", definitionOfDone: "ITEM-DOD" },
    { title: "Task pub-2", definitionOfDone: "PROPOSED-DOD" },
  ]);
  f.diverge("pub-1", { definitionOfDone: "BOARD-DOD", mode: "write" });
  syncRoomPublication(f.store, { roomId: "commons", state: f.store.room("commons").state });
  assert.deepEqual(tasks(), [
    { title: "Task pub-1", definitionOfDone: "BOARD-DOD" },
    { title: "Task pub-2", definitionOfDone: "PROPOSED-DOD" },
  ]);
});

test("slice3b MCP work view: room_list_work resolves the brief board-first, proposed items fall back", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workitems-brief-mcp-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  const identity = store.identities.create("Owen");
  new AgentRooms(store).create(identity.secret, { roomId: "test-room", title: "Test", purpose: "Brief readers", kind: "personal", displayName: "Owner" });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (name, args) => (await (await fetch(`${origin}/room/mcp?profile=full`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.secret}` }, body: JSON.stringify({ jsonrpc: "2.0", id: "test", method: "tools/call", params: { name, arguments: args } }) })).json()).result;
  const send = (type, data) => store.command(identity.secret, "test-room", { id: crypto.randomUUID(), type, data });
  send("work.proposed", { workItemId: "task", title: "Task", definitionOfDone: "ITEM-DOD", mode: "read", accountableMemberId: identity.identityId });
  const listed = async () => (await call("room_list_work", { roomId: "test-room", focus: "all" })).structuredContent.work.find(w => w.id === "task");
  // Proposed: no board row — item fallback.
  assert.equal(store.workClaims.get("test-room", "task"), null);
  let entry = await listed();
  assert.equal(entry.definitionOfDone, "ITEM-DOD");
  assert.equal(entry.mode, "read");
  // Accepted: row exists and agrees — output unchanged.
  send("work.accepted", { workItemId: "task", expectedRevision: 0 });
  entry = await listed();
  assert.equal(entry.definitionOfDone, "ITEM-DOD");
  assert.equal(entry.mode, "read");
  // Diverged row: board wins.
  const row = store.workClaims.get("test-room", "task");
  store.workClaims.set("test-room", { ...row, definitionOfDone: "BOARD-DOD", mode: "write" });
  entry = await listed();
  assert.equal(entry.definitionOfDone, "BOARD-DOD");
  assert.equal(entry.mode, "write");
});
