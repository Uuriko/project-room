// Guardian census F5: operator projection repair. The journal is the
// source of truth, so a torn rooms.projection is repaired by replay —
// plan names the torn bytes by digest and proves the replay, execute
// replaces only the materialization under the plan's digests, and every
// refusal path writes nothing.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { planProjectionRepair, executeProjectionRepair } from "../server/operator-projection-repair.mjs";
import { operatorStatus } from "../server/operator-status.mjs";
import { runPatrolTick } from "../server/patrol.mjs";

const sha256 = text => createHash("sha256").update(text).digest("hex");

function openStore(roomId = "repair-room") {
  const directory = mkdtempSync(join(tmpdir(), "project-room-projection-repair-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  return store;
}
function post(store, id, body, roomId = "repair-room") {
  const key = store.issueAccessKey(roomId, "owner");
  store.command(key, roomId, { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
}
function seededStore() {
  const store = openStore();
  post(store, "m1", "first body");
  post(store, "m2", "second body");
  return store;
}
const rawProjection = (store, roomId = "repair-room") =>
  store.db.prepare("SELECT sequence, projection, archived_at FROM rooms WHERE id=?").get(roomId);
const eventsDigest = (store, roomId = "repair-room") =>
  sha256(JSON.stringify(store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId)));
const tear = (store, roomId = "repair-room") => {
  const torn = rawProjection(store, roomId).projection.slice(0, 40) + "";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(torn, roomId);
  return torn;
};

test("plan on a healthy room reports parses and refuses repairable", () => {
  const store = seededStore();
  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-1");
  assert.equal(plan.stored.parses, true);
  assert.equal(plan.replay.ok, true);
  assert.equal(plan.repairable, false);
  assert.equal(plan.messages, undefined); // counts live on replay, not the top level
  assert.equal(plan.replay.messages, 2);
  assert.throws(
    () => executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-2"),
    error => error?.status === 422 && error?.code === "not_corrupt"
  );
});

test("a torn projection is repaired from the journal with data conserved", () => {
  const store = seededStore();
  const before = store.room("repair-room");
  const journalDigest = eventsDigest(store);
  const torn = tear(store);
  // #4127 (corruption-hardening PR2): reads of an unreadable projection now
  // fail with the typed room_corrupt_projection error, not a raw SyntaxError.
  assert.throws(() => store.room("repair-room"), error => error?.status === 500 && error?.code === "room_corrupt_projection");

  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-3");
  assert.equal(plan.stored.parses, false);
  assert.equal(plan.stored.parseErrorClass, "SyntaxError");
  assert.equal(plan.stored.sha256, sha256(torn));
  assert.equal(plan.replay.ok, true);
  assert.equal(plan.repairable, true);
  assert.equal(plan.replay.messages, 2);

  // The plan's digests are the execute guard: a stale plan is a 409 and
  // writes nothing.
  assert.throws(
    () => executeProjectionRepair(store, { roomId: "repair-room", expectedSha256: "0".repeat(64), expectedSequence: plan.sequence }, "req-4"),
    error => error?.status === 409 && error?.code === "plan_changed"
  );
  assert.equal(rawProjection(store).projection, torn);

  const outcome = executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard, reason: "census F5 drill" }, "req-5");
  assert.equal(outcome.before.sha256, sha256(torn));
  assert.equal(outcome.sequence, plan.sequence);
  assert.equal(outcome.messages, 2);
  // The room reads cleanly and the state is exactly the replay — members
  // and messages conserved, journal untouched, head unmoved.
  assert.deepEqual(store.room("repair-room"), before);
  assert.deepEqual(store.room("repair-room"), store.rebuildProjection("repair-room"));
  assert.equal(eventsDigest(store), journalDigest);
  assert.equal(rawProjection(store).sequence, plan.sequence);

  const actions = store.db.prepare("SELECT action, result FROM operator_actions ORDER BY at, action").all();
  assert.ok(actions.some(row => row.action === "projection_repair.plan" && row.result === "repairable"));
  assert.ok(actions.some(row => row.action === "projection_repair.execute" && row.result === "repaired"));
  assert.ok(actions.some(row => row.action === "projection_repair.execute" && row.result === "refused:plan_changed"));
});

test("repair clears the patrol park so the room is re-patrolled", () => {
  const store = seededStore();
  runPatrolTick(store); // creates patrol_blocks
  tear(store);
  store.db.prepare("INSERT INTO patrol_blocks (room_id, sequence, event_id, head_seq, error_class, error, blocked_at) VALUES ('repair-room', 1, NULL, 3, 'SyntaxError', 'torn', 1)").run();
  assert.equal(store.patrolBlocks().length, 1);
  assert.equal(operatorStatus(store).patrolBlocks.length, 1);

  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-6");
  assert.equal(plan.park?.errorClass, "SyntaxError");
  const outcome = executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-7");
  assert.equal(outcome.parkCleared, true);
  assert.equal(store.patrolBlocks().length, 0);
  const tick = runPatrolTick(store);
  assert.equal(tick.errors ?? 0, 0);
});

test("a torn journal refuses: replay fails in the plan and execute writes nothing", () => {
  const store = seededStore();
  const torn = tear(store);
  // Break the replay itself: an event body that is valid JSON but not an
  // event — the reducer throws on it mid-replay. (Raw-JSON tears and row
  // surgery are refused by the store's own generated columns and foreign
  // keys before they land; this is the journal tear that can exist.)
  // This room's path is the backup restore, not this repair.
  store.db.prepare("UPDATE events SET body='null' WHERE room_id='repair-room' AND sequence=3").run();
  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-8");
  assert.equal(plan.replay.ok, false);
  assert.equal(plan.repairable, false);
  assert.throws(
    () => executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-9")
  );
  assert.equal(rawProjection(store).projection, torn);
});

// #4127: repairability extends to shape failures — projections that parse
// but are not a state for this room. The read path refuses them with the
// typed room_corrupt_projection error; this tool is their repair path.
test("a hollow ({}) projection is repairable: plan names the shape, execute rebuilds", () => {
  const store = seededStore();
  store.db.prepare("UPDATE rooms SET projection='{}' WHERE id='repair-room'").run();
  assert.throws(() => store.room("repair-room"), error => error?.code === "room_corrupt_projection");
  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-shape-1");
  assert.equal(plan.stored.parses, true);
  assert.equal(plan.stored.shapeProblem, "room_missing");
  assert.equal(plan.replay.ok, true);
  assert.equal(plan.repairable, true);
  const outcome = executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-shape-2");
  assert.equal(outcome.messages, 2);
  assert.equal(store.room("repair-room").state.messages.length, 2);
});

test("a projection filed under a foreign room id is repairable", () => {
  const store = seededStore();
  const foreign = JSON.parse(rawProjection(store).projection);
  foreign.room.id = "someone-else";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='repair-room'").run(JSON.stringify(foreign));
  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-shape-3");
  assert.equal(plan.stored.shapeProblem, "room_id_mismatch");
  assert.equal(plan.repairable, true);
  executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-shape-4");
  assert.equal(store.room("repair-room").state.room.id, "repair-room");
  assert.equal(store.room("repair-room").state.messages.length, 2);
});

test("a well-shaped projection that merely drifted is still not this repair's", () => {
  const store = seededStore();
  const drifted = JSON.parse(rawProjection(store).projection);
  drifted.messages = drifted.messages.slice(0, 1);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='repair-room'").run(JSON.stringify(drifted));
  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-shape-5");
  assert.equal(plan.stored.parses, true);
  assert.equal(plan.stored.shapeProblem, null);
  assert.equal(plan.repairable, false);
  assert.throws(
    () => executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-shape-6"),
    error => error?.status === 422 && error?.code === "not_corrupt"
  );
});

test("archived rooms are refused: the compacted shape is not this repair's", () => {
  const store = seededStore();
  tear(store);
  store.db.prepare("UPDATE rooms SET archived_at='2026-10-18T00:00:00.000Z' WHERE id='repair-room'").run();
  const plan = planProjectionRepair(store, { roomId: "repair-room" }, "req-10");
  assert.equal(plan.archived, true);
  assert.equal(plan.repairable, false);
  assert.throws(
    () => executeProjectionRepair(store, { roomId: "repair-room", ...plan.executeGuard }, "req-11"),
    error => error?.status === 422 && error?.code === "repair_unsupported"
  );
});
