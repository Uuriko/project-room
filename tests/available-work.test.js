// AvailableWork projection (EXECUTION-BRIEF decision #5): the ONE
// availability definition for "what work can I take?". Board rules align
// with needs-me's openWorkOf (usable + unclaimed + kind work + deps done +
// viewer may write claims); work items must be accepted and unheld; public
// tasks reuse the facade packet's own claim.state classification.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { availableBoardRows, availableClaimsInRoom, availablePublicTasks, availableWorkInRoom } from "../server/available-work.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

const ROOM = "available-demo";
const FUTURE_LEASE = new Date(Date.now() + 6 * 3600 * 1000).toISOString();

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "available-work-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Available Demo",
        purpose: "Fixture room for the AvailableWork projection.", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.command(ownerKey, ROOM, { id: "aw-add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Worker", kind: "agent",
    permissions: ["accept_work", "write_external", "complete_work"], accountableHumanId: "owner" } });
  store.command(ownerKey, ROOM, { id: "aw-add-reader", type: T.MEMBER_ADDED, data: {
    memberId: "reader", displayName: "Reader", kind: "agent", permissions: [], accountableHumanId: "owner" } });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

const claim = (id, extra = {}) => ({ id, title: `Claim ${id}`, state: "unclaimed", owner: null, history: [], ...extra });

test("board availability: deps, kind, invalidation, and state gates", t => {
  const { store } = fixture(t);
  store.workClaims.set(ROOM, claim("open-1"));
  store.workClaims.set(ROOM, claim("done-1", { state: "done", owner: "worker" }));
  store.workClaims.set(ROOM, claim("dep-ready", { dependsOn: ["done-1"] }));
  store.workClaims.set(ROOM, claim("dep-blocked", { dependsOn: ["open-1"] }));
  store.workClaims.set(ROOM, claim("not-work", { kind: "announcement" }));
  store.workClaims.set(ROOM, claim("flagged", { premiseFlag: { premiseId: "p1" } }));
  store.workClaims.set(ROOM, claim("superseded", { supersededBy: "open-1" }));
  store.workClaims.set(ROOM, claim("taken", { state: "claimed", owner: "worker" }));
  const rows = availableBoardRows(store.workClaims.list(ROOM));
  assert.deepEqual(rows.map(row => row.id).sort(), ["dep-ready", "open-1"]);
});

test("room projection: viewer gate + one shape + claimAction", t => {
  const { store } = fixture(t);
  store.workClaims.set(ROOM, claim("open-1"));
  const forWorker = availableClaimsInRoom(store, ROOM, { viewerId: "worker" });
  assert.equal(forWorker.length, 1);
  assert.deepEqual(forWorker[0], { id: "open-1", title: "Claim open-1", source: "board", roomId: ROOM,
    state: "unclaimed", owner: null, leaseExpiresAt: null, untrusted: true,
    claimAction: { method: "POST", endpoint: `/api/rooms/${ROOM}/work-claims/open-1/claim`,
      params: { requestId: "<uuid>" } } });
  // A member who may not write claims sees no claimable board work —
  // the same gate needs-me applies (no silent dead-end at claim time).
  assert.deepEqual(availableClaimsInRoom(store, ROOM, { viewerId: "reader" }), []);
  // No named viewer: no narrowing (internal/public reads).
  assert.equal(availableClaimsInRoom(store, ROOM).length, 1);
});

test("room projection: work items join board claims; zero-inventory is explicit", t => {
  const { store, ownerKey } = fixture(t);
  // Nothing anywhere: the projection can say so, with a total.
  assert.deepEqual(availableWorkInRoom(store, ROOM, { viewerId: "worker" }), { items: [], total: 0 });
  const workerKey = store.issueAccessKey(ROOM, "worker");
  store.command(ownerKey, ROOM, { id: "aw-propose", type: T.WORK_PROPOSED, data: {
    workItemId: "item-1", title: "Accepted and unheld", definitionOfDone: "done",
    accountableMemberId: "worker", verifierMemberId: "owner", mode: "write" } });
  // Proposed is not claimable yet.
  assert.equal(availableWorkInRoom(store, ROOM, { viewerId: "worker" }).total, 0);
  store.command(workerKey, ROOM, { id: "aw-accept", type: T.WORK_ACCEPTED, data: {
    workItemId: "item-1", expectedRevision: 0 } });
  const after = availableWorkInRoom(store, ROOM, { viewerId: "worker" });
  assert.equal(after.total, 1);
  // Decision #10: the accepted item has a board card (the write-path
  // sync created it at accept), and AvailableWork is board-only — the
  // item is offered once, as the board claim.
  assert.equal(after.items[0].source, "board");
  assert.equal(after.items[0].claimAction.endpoint, `/api/rooms/${ROOM}/work-claims/item-1/claim`);
  // Once held under a live lease it leaves the available set.
  store.command(workerKey, ROOM, { id: "aw-claim", type: T.CLAIM_ACQUIRED, data: {
    workItemId: "item-1", expectedRevision: 1, repository: "repo", ref: "main",
    paths: ["server/available-work.mjs"], expiresAt: FUTURE_LEASE } });
  assert.equal(availableWorkInRoom(store, ROOM, { viewerId: "worker" }).total, 0);
});

test("public tasks: only unclaimed packets, paginated scan", () => {
  const packet = (taskId, state) => ({ taskId, title: `Task ${taskId}`, namespaceId: "commons",
    termsVersion: 1, claimable: state === "unclaimed",
    claim: { state, generation: 1, leaseExpiresAt: null } });
  const pages = {
    "": { tasks: [packet("t1", "submitted"), packet("t2", "unclaimed")], nextCursor: "t2" },
    t2: { tasks: [packet("t3", "claimed"), packet("t4", "unclaimed")], nextCursor: null }
  };
  const store = { publicWorkClaims: { list: ({ after }) => pages[after] } };
  const { items, total } = availablePublicTasks(store, { limit: 50 });
  assert.deepEqual(items.map(item => item.id), ["t2", "t4"]);
  assert.equal(total, 2);
  assert.equal(items[0].source, "publicTask");
  assert.equal(items[0].claimAction.endpoint, "/api/public-work/tasks/t2/claim");
  // No facade: explicit empty, never a throw.
  assert.deepEqual(availablePublicTasks({}), { items: [], total: 0 });
});

test("public tasks: deadline-passed packets are not offered, and total counts the whole pool (#3879)", () => {
  // Facade-faithful packets: a deadline-passed task keeps claim.state
  // "unclaimed" but carries claimable:false (#3707), and the facade's
  // claim op refuses it with 409 public_work_deadline_passed. The pool
  // must not offer it, and total is the pool-wide claimable count (the
  // availableWorkInRoom contract), not the limit-capped page size.
  const packet = (taskId, claimable) => ({ taskId, title: `Task ${taskId}`, namespaceId: "commons",
    termsVersion: 1, claimable, claim: { state: "unclaimed", generation: 1, leaseExpiresAt: null } });
  const pages = {
    "": { tasks: [packet("open-1", true), packet("stale-1", false)], nextCursor: "stale-1" },
    "stale-1": { tasks: [packet("open-2", true), packet("open-3", true)], nextCursor: null }
  };
  const store = { publicWorkClaims: { list: ({ after }) => pages[after] } };
  const { items, total } = availablePublicTasks(store, { limit: 2 });
  assert.deepEqual(items.map(item => item.id), ["open-1", "open-2"]);
  assert.equal(total, 3);
});
