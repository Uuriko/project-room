// T3-L10f-C3 (G8, partial): request-run host reports partially bypassed the
// archived-room freeze. Only claim/working checked state.room.archivedAt
// (and refused with request_run_changed); result_ready, needs_attention and
// delivered updated the request_runs row in an archived room — executed at
// pin 1ab906c3 and re-executed unchanged at PR #5502's head 106b1bd8
// (#5502 guards the work-claim registry, bounty intake, credentials, collab,
// project-map and invite minting; request_runs writes are direct SQL in
// server/request-runs.mjs and never pass through any of those choke points).
//
// Fix shape mirrors #5502 / refuseArchivedWrite: every apply() write in an
// archived room refuses 409 room_archived with the freeze message, at the
// module's write entry, before any INSERT/UPDATE. Reads (list) stay open.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { buildReplyCommand } from "../client/reply-actions.mjs";

const isArchivedRefusal = error => error?.status === 409 && error?.code === "room_archived";

function fixture(t) {
  const store = new RoomStore(":memory:");
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Owen"), worker = store.identities.create("Worker");
  rooms.create(owner.secret, { roomId: "commons", title: "Pickup", purpose: "Test", kind: "personal" });
  linkWithProof(store, owner.secret, "commons", worker, { displayName: "Worker", permissions: [] });
  store.dmConsents.request("commons", owner.identityId, worker.identityId, "Fixture");
  store.dmConsents.decide("commons", worker.identityId, owner.identityId, "approve");
  const post = id => store.command(owner.secret, "commons", { id, type: "message.posted", data: {
    messageId: id, toMemberId: worker.identityId, requestKind: "reply", body: "private text" } });
  post("open1"); post("open2"); post("open3");
  const requests = Object.fromEntries(store.replyRequests.list(worker.secret, "commons").requests.map(r => [r.id, r]));
  const apply = (id, action, extra = {}) => store.requestRuns.apply(worker.secret, "commons",
    { requestMessageId: id, attemptId: "attempt-" + id, action, ...extra });
  const basis = id => ({ expectedRequestRevision: requests[id].revision, contextEventId: requests[id].contextEventId });
  for (const id of ["open1", "open2"]) apply(id, "claim", basis(id));
  // Answer open2 while live, so its delivered leg is reachable after archiving.
  const sel = store.replyRequests.selected(worker.secret, "commons", "open2");
  const action = sel.responseActions.find(a => a.arguments.responseOutcome === "answered");
  store.command(worker.secret, "commons", buildReplyCommand(
    { roomId: "commons", memberId: worker.identityId }, "room_respond_to_request",
    { ...action.arguments, requestId: "answer-open2", body: "Done." }));
  const rows = () => store.db.prepare("SELECT request_id,state FROM request_runs ORDER BY request_id").all()
    .map(row => ({ request_id: row.request_id, state: row.state }));
  const archive = () => store.command(owner.secret, "commons",
    { id: "archive-room", type: "room.archived", data: { reason: "pilot over" } });
  t.after(() => store.close());
  return { store, worker, apply, basis, rows, archive };
}

test("control: host reports land in a live room", t => {
  const f = fixture(t);
  assert.equal(f.apply("open1", "result_ready").state, "result_ready");
  assert.equal(f.apply("open2", "delivered").state, "delivered");
  assert.deepEqual(f.rows(), [
    { request_id: "open1", state: "result_ready" },
    { request_id: "open2", state: "delivered" }
  ]);
});

test("archived room: every request-run write refuses 409 room_archived and mutates nothing", t => {
  const f = fixture(t);
  f.archive();
  const before = f.rows();
  assert.deepEqual(before, [
    { request_id: "open1", state: "working" },
    { request_id: "open2", state: "working" }
  ]);
  assert.throws(() => f.apply("open1", "working", f.basis("open1")), isArchivedRefusal,
    "working in an archived room must refuse 409 room_archived");
  assert.throws(() => f.apply("open3", "claim", f.basis("open3")), isArchivedRefusal,
    "claim in an archived room must refuse 409 room_archived");
  assert.throws(() => f.apply("open1", "result_ready"), isArchivedRefusal,
    "result_ready in an archived room must refuse 409 room_archived");
  assert.throws(() => f.apply("open1", "needs_attention"), isArchivedRefusal,
    "needs_attention in an archived room must refuse 409 room_archived");
  assert.throws(() => f.apply("open2", "delivered"), isArchivedRefusal,
    "delivered in an archived room must refuse 409 room_archived");
  assert.deepEqual(f.rows(), before, "no request_runs row changed in the archived room");
  // Reads stay open in an archived room.
  const list = f.store.requestRuns.list(f.worker.secret, "commons");
  assert.equal(list.runs.open1.state, "working");
  assert.equal(list.runs.open2.state, "working");
});
