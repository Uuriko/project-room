// PERF-10X L4 (Lane 3 read-paths item #3): one board list per request.
//
// The composite agent reads — orient, activation-pack, and context (which
// embeds orient) — each used to decode the whole board two to three times
// per request: once directly, once through AvailableWork, and (for agent
// viewers / token callers) once again through the fleet badge and the
// next-actions snapshot. Lane 3 measured orient 39.3 ms / context 42.3 ms /
// activation-pack 46.6 ms median at fixture scale, each decoding ~800
// rows. The fix threads a per-request memoized board list
// (server/available-work.mjs: memoizeBoardList) through every consumer.
//
// Proof method (the seam Lane 3's harness counted): store.workClaims.list
// is the one materialisation point — every call is a full SELECT + JSON
// decode of every claim row (server/work-claim-sqlite.mjs). These tests
// wrap that seam, count calls and decoded rows per composite request, and
// assert exactly ONE materialisation, with the payloads unchanged:
// embedded copies deep-equal (byte-equal after stripping the volatile
// clock fields) the standalone builders, and a board change between two
// requests is visible in the second (the memo never outlives a request).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildOrient } from "../server/orient.mjs";
import { buildActivationPack } from "../server/room-activation-pack.mjs";
import { memoizeBoardList } from "../server/available-work.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

const ROOM = "boardlist-demo";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-boardlist-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Boardlist Demo",
        purpose: "Fixture room for the board-list memo.", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Room owner", kind: "human",
        permissions: [...PERMISSIONS] } })
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.command(ownerKey, ROOM, { id: "bl-add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Worker", kind: "agent",
    permissions: ["accept_work", "write_external", "complete_work"], accountableHumanId: "owner" } });
  const workerKey = store.issueAccessKey(ROOM, "worker");
  store.command(ownerKey, ROOM, { id: "bl-propose", type: T.WORK_PROPOSED, data: {
    workItemId: "bl-work-1", title: "Fixture work", definitionOfDone: "done.",
    accountableMemberId: "worker", verifierMemberId: "owner", mode: "write" } });
  store.command(workerKey, ROOM, { id: "bl-accept", type: T.WORK_ACCEPTED, data: {
    workItemId: "bl-work-1", expectedRevision: 0 } });
  // Board rows: the accepted work item's board card (from the accept
  // above) plus one claimable, one claimed by the worker with a lease
  // expiring inside the next-actions heartbeat window, one done, and one
  // superseded — so every board consumer in the composite reads has rows
  // it actually uses.
  const lease = new Date(Date.now() + 90 * 60000).toISOString();
  store.workClaims.set(ROOM, { id: "board-open-1", title: "Pick me up", state: "unclaimed", owner: null, history: [] });
  store.workClaims.set(ROOM, { id: "board-taken-1", title: "Already claimed", state: "claimed", owner: "worker", history: [], leaseExpiresAt: lease });
  store.workClaims.set(ROOM, { id: "board-done-1", title: "Finished", state: "done", owner: "worker", history: [] });
  store.workClaims.set(ROOM, { id: "board-superseded-1", title: "Superseded", state: "unclaimed", owner: null, history: [], supersededBy: "board-open-1" });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, workerKey };
}

// Wrap the board materialisation seam with a counter. Returns the counter
// plus the board's row count at fixture time.
function countBoardLists(store) {
  const boardRows = store.workClaims.list(ROOM).length;
  const counter = { calls: 0, rows: 0, reset() { this.calls = 0; this.rows = 0; } };
  const original = store.workClaims.list.bind(store.workClaims);
  store.workClaims.list = roomId => {
    const rows = original(roomId);
    counter.calls += 1;
    counter.rows += rows.length;
    return rows;
  };
  return { counter, boardRows };
}

async function serve(t, store) {
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return origin;
}

// Clock fields differ between two builder calls; everything else must be
// byte-identical. Strip them recursively, then compare the JSON strings.
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "generatedAt" && key !== "evaluatedAt")
      .map(([key, entry]) => [key, stripVolatile(entry)]));
  }
  return value;
}
const bytesOf = value => JSON.stringify(stripVolatile(value));

test("memoizeBoardList: lazy, per-room, cached, and failure reads as an empty board", () => {
  let calls = 0;
  const store = { workClaims: { list: roomId => { calls += 1; return [{ id: `row-${roomId}` }]; } } };
  const boardList = memoizeBoardList(store);
  assert.equal(calls, 0); // lazy: creating the memo lists nothing
  assert.deepEqual(boardList("a"), [{ id: "row-a" }]);
  assert.deepEqual(boardList("a"), [{ id: "row-a" }]);
  assert.equal(calls, 1); // one materialisation per room per memo
  assert.deepEqual(boardList("b"), [{ id: "row-b" }]);
  assert.equal(calls, 2);
  // A second memo (the next request) lists again — nothing is cached
  // across requests.
  assert.deepEqual(memoizeBoardList(store)("a"), [{ id: "row-a" }]);
  assert.equal(calls, 3);
  // A failing list memoizes as [], matching every consumer's existing
  // catch-to-empty behaviour.
  let failures = 0;
  const broken = memoizeBoardList({ workClaims: { list: () => { failures += 1; throw new Error("boom"); } } });
  assert.deepEqual(broken("a"), []);
  assert.deepEqual(broken("a"), []);
  assert.equal(failures, 1);
});

test("orient decodes the board exactly once (direct, fleet badge, and next-actions share it)", t => {
  const f = fixture(t);
  const { counter, boardRows } = countBoardLists(f.store);
  const payload = buildOrient(f.store, ROOM, "worker", { token: f.workerKey });
  assert.equal(counter.calls, 1);
  assert.equal(counter.rows, boardRows);
  // The consumers that used to re-list really did run off the shared
  // board: the fleet badge is in `you`, and the heartbeat next-action for
  // the worker's expiring lease is present.
  assert.ok(payload.you.state);
  assert.ok(payload.nextActions.some(item => item.kind === "heartbeat-due"));
  assert.deepEqual(payload.availableClaims.map(item => item.id), ["bl-work-1", "board-open-1"]);
  // Human viewer with a token: direct + next-actions, still one decode.
  counter.reset();
  buildOrient(f.store, ROOM, "owner", { token: f.ownerKey });
  assert.equal(counter.calls, 1);
  assert.equal(counter.rows, boardRows);
});

test("activation pack decodes the board exactly once, shared with its embedded orient", t => {
  const f = fixture(t);
  const { counter, boardRows } = countBoardLists(f.store);
  const pack = buildActivationPack(f.store, ROOM, "worker");
  assert.equal(counter.calls, 1);
  assert.equal(counter.rows, boardRows);
  // Behaviour preservation: the pack's openClaims and embedded orient are
  // byte-identical to the standalone builders over the same board.
  const standaloneOrient = buildOrient(f.store, ROOM, "worker", { text: false });
  assert.equal(bytesOf(pack.orient), bytesOf(standaloneOrient));
  assert.equal(bytesOf(pack.openClaims), bytesOf(standaloneOrient.availableClaims));
  assert.deepEqual(pack.openClaims.map(item => item.id), ["bl-work-1", "board-open-1"]);
});

test("context composite (roomContext + embedded orient) decodes the board exactly once", t => {
  const f = fixture(t);
  const { counter, boardRows } = countBoardLists(f.store);
  // The HTTP/MCP context routes compose exactly this: the store context
  // (no board read) plus an orient built with the request's board memo.
  const boardList = memoizeBoardList(f.store);
  const context = f.store.roomContext(f.workerKey, ROOM, {});
  const payload = { ...context, orient: buildOrient(f.store, ROOM, "worker", { text: false, token: f.workerKey, boardList }) };
  assert.equal(counter.calls, 1);
  assert.equal(counter.rows, boardRows);
  const standaloneOrient = buildOrient(f.store, ROOM, "worker", { text: false, token: f.workerKey });
  assert.equal(bytesOf(payload.orient), bytesOf(standaloneOrient));
});

test("served orient / activation-pack / context each decode the board exactly once per HTTP request", async t => {
  const f = fixture(t);
  const { counter, boardRows } = countBoardLists(f.store);
  const origin = await serve(t, f.store);
  const get = async path => {
    counter.reset();
    const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${f.workerKey}` } });
    assert.equal(response.status, 200, path);
    return { body: await response.json(), calls: counter.calls, rows: counter.rows };
  };
  for (const path of [`/api/rooms/${ROOM}/activation-pack`, `/api/rooms/${ROOM}/context`]) {
    const { body, calls, rows } = await get(path);
    assert.equal(calls, 1, `${path} listed the board ${calls} times`);
    assert.equal(rows, boardRows, path);
    if (path.endsWith("/context")) assert.ok(body.orient, "context embeds orient");
    if (path.endsWith("/activation-pack")) assert.ok(body.orient, "pack embeds orient");
  }
});

test("the memo never outlives a request: a board change is visible in the next request", t => {
  const f = fixture(t);
  const { counter } = countBoardLists(f.store);
  const first = buildOrient(f.store, ROOM, "worker");
  assert.equal(counter.calls, 1);
  assert.deepEqual(first.availableClaims.map(item => item.id), ["bl-work-1", "board-open-1"]);
  f.store.workClaims.set(ROOM, { id: "board-open-2", title: "New work", state: "unclaimed", owner: null, history: [] });
  counter.reset();
  const second = buildOrient(f.store, ROOM, "worker");
  assert.equal(counter.calls, 1); // fresh memo, one fresh materialisation
  assert.deepEqual(second.availableClaims.map(item => item.id), ["bl-work-1", "board-open-1", "board-open-2"]);
});
