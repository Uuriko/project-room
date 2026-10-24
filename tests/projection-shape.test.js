// #4127: parseable-but-wrong projections. Before this fix the chaos shape
// table read: {} / [] / "hello" served a hollow room, null threw raw
// TypeErrors from every surface, {"room":{"id":...}} served partial state,
// a valid projection under a foreign room id was served silently (patrol
// filed nothing), and none of them had a repair path. Now the read path
// refuses every unsound shape with one typed error
// (500 room_corrupt_projection), the repair tool treats shape failures as
// repairable, and patrol names the room-id mismatch. A well-shaped
// projection that merely drifted (a message dropped) still reads — drift
// reconciliation stays the recovery audit's job.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectionShapeProblem, projectionShapeProblems } from "../server/projection-at-rest.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shape-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom("alpha"));
  const key = store.issueAccessKey("alpha", "owner");
  for (const [id, body] of [["m1", "hello"], ["m2", "second"], ["m3", "third"]]) {
    store.command(key, "alpha", { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
  }
  const healthy = store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection;
  return { store, key, healthy };
}

const setProjection = (store, text) => store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(text);
const readError = store => { try { store.room("alpha"); return null; } catch (error) { return error; } };

function assertTypedCorruption(error, problem) {
  assert.ok(error, "the read must throw");
  assert.equal(error.status, 500);
  assert.equal(error.code, "room_corrupt_projection");
  assert.ok(!(error instanceof TypeError), "no raw TypeError leaks");
  assert.ok(!(error instanceof SyntaxError), "no raw SyntaxError leaks");
  if (problem) assert.match(error.message, new RegExp(problem));
}

test("the shape validator names each unsound shape and accepts sound ones", () => {
  assert.equal(projectionShapeProblem(null, "alpha"), "not_an_object");
  assert.equal(projectionShapeProblem([], "alpha"), "not_an_object");
  assert.equal(projectionShapeProblem("hello", "alpha"), "not_an_object");
  assert.equal(projectionShapeProblem({}, "alpha"), "room_missing");
  assert.equal(projectionShapeProblem({ room: { id: "alpha" } }, "alpha"), "members_missing");
  assert.equal(projectionShapeProblem({ room: { id: "omega" }, members: {}, channels: {}, messages: [], workItems: {} }, "alpha"), "room_id_mismatch");
  assert.equal(projectionShapeProblem({ room: { id: "alpha" }, members: {}, channels: {}, messages: [], workItems: {} }, "alpha"), null);
});

test("every unsound chaos shape fails the read with the typed error", t => {
  const { store, healthy } = fixture(t);
  const shapes = [
    ["garbage{", null],
    ["{}", "room_missing"],
    ["[]", "not_an_object"],
    ['"hello"', "not_an_object"],
    ["null", "not_an_object"],
    ['{"room":{"id":"alpha"}}', "members_missing"],
  ];
  for (const [text, problem] of shapes) {
    setProjection(store, text);
    assertTypedCorruption(readError(store), problem);
  }
  // A complete, valid projection filed under the wrong room id.
  const foreign = JSON.parse(healthy);
  foreign.room.id = "omega";
  setProjection(store, JSON.stringify(foreign));
  assertTypedCorruption(readError(store), "room_id_mismatch");
  // Writes refuse the same way — no raw TypeError from the command path.
  assertTypedCorruption((() => { try { store.command(store.issueAccessKey("alpha", "owner"), "alpha", { id: "cmd-x", type: "message.posted", data: { body: "x", messageId: "x" } }); return null; } catch (error) { return error; } })(), "room_id_mismatch");
  // Restoring the healthy bytes restores service.
  setProjection(store, healthy);
  assert.equal(store.room("alpha").state.messages.length, 3);
});

test("a well-shaped projection that drifted still reads (audit territory, not corruption)", t => {
  const { store, healthy } = fixture(t);
  const drifted = JSON.parse(healthy);
  drifted.messages = drifted.messages.slice(0, 2);
  setProjection(store, JSON.stringify(drifted));
  assert.equal(store.room("alpha").state.messages.length, 2);
});

test("patrol names the room-id mismatch instead of staying silent", t => {
  const { store, healthy } = fixture(t);
  const foreign = JSON.parse(healthy);
  foreign.room.id = "omega";
  setProjection(store, JSON.stringify(foreign));
  store.patrolTick();
  const findings = store.patrolFindings().filter(finding => finding.room_id === "alpha");
  const mismatch = findings.find(finding => finding.kind === "projection_room_mismatch");
  assert.ok(mismatch, `expected a projection_room_mismatch finding, got ${JSON.stringify(findings.map(f => f.kind))}`);
  assert.equal(mismatch.invariant, "sequence");
  assert.equal(mismatch.detail?.storedRoomId, "omega");
});

test("patrol files no identity finding for a healthy room", t => {
  const { store } = fixture(t);
  store.patrolTick();
  assert.deepEqual(store.patrolFindings().filter(finding => finding.kind === "projection_room_mismatch"), []);
});

test("the shape validator reports the full problem set in check order", () => {
  const sound = { room: { id: "alpha" }, members: {}, channels: {}, messages: [], workItems: {} };
  assert.deepEqual(projectionShapeProblems(sound, "alpha"), []);
  assert.deepEqual(projectionShapeProblems(null, "alpha"), ["not_an_object"]);
  assert.deepEqual(projectionShapeProblems([], "alpha"), ["not_an_object"]);
  assert.deepEqual(projectionShapeProblems({}, "alpha"), ["room_missing", "members_missing", "channels_missing", "messages_missing", "work_items_missing"]);
  // Compounds keep every problem, in the fixed check order — the set the
  // deferred-open predicate decides on.
  assert.deepEqual(projectionShapeProblems({ room: { id: "alpha" }, members: {} }, "alpha"),
    ["channels_missing", "messages_missing", "work_items_missing"]);
  assert.deepEqual(projectionShapeProblems({ room: { id: "alpha" }, members: {}, messages: [] }, "alpha"),
    ["channels_missing", "work_items_missing"]);
  assert.deepEqual(projectionShapeProblems({ room: { id: "alpha" }, members: {}, channels: {} }, "alpha"),
    ["messages_missing", "work_items_missing"]);
  // The singular stays the first problem of the set.
  assert.equal(projectionShapeProblem({ room: { id: "alpha" }, members: {} }, "alpha"), "channels_missing");
  assert.equal(projectionShapeProblem({ room: { id: "alpha" }, members: {}, channels: {} }, "alpha"), "messages_missing");
});

// PR #4137 delta: the deferred-open deferral covers channels_missing ONLY
// when it is the projection's sole shape problem. projectionShapeProblem
// reports the first problem in a fixed order (members → channels →
// messages → work_items), so a compound whose second problem sorts after
// channels_missing is gate-visible as plain channels_missing — deferring
// on that alone served a hollow state (messages/workItems undefined) in
// deferred mode, the leak #4127 forbids. Both compound shapes must refuse
// with the typed error under deferred open.
function deferredStore(t, mutate) {
  const directory = mkdtempSync(join(tmpdir(), "room-shape-deferred-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom("alpha"));
  const parsed = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection);
  mutate(parsed);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(parsed));
  store.close();
  const deferred = new RoomStore(filename, { integrity: "deferred" });
  t.after(() => { try { deferred.close(); } catch { /* already closed */ } });
  return { deferred, parsed };
}

test("deferred open refuses a channels+messages compound with the typed error", t => {
  const { deferred, parsed } = deferredStore(t, state => { delete state.channels; delete state.messages; });
  // Precondition: the gate-visible first problem is channels_missing — the
  // trap the deferral predicate must see through.
  assert.equal(projectionShapeProblem(parsed, "alpha"), "channels_missing");
  assert.deepEqual(projectionShapeProblems(parsed, "alpha"), ["channels_missing", "messages_missing"]);
  assertTypedCorruption(readError(deferred));
});

test("deferred open refuses a channels+work_items compound with the typed error", t => {
  const { deferred, parsed } = deferredStore(t, state => { delete state.channels; delete state.workItems; });
  assert.equal(projectionShapeProblem(parsed, "alpha"), "channels_missing");
  assert.deepEqual(projectionShapeProblems(parsed, "alpha"), ["channels_missing", "work_items_missing"]);
  assertTypedCorruption(readError(deferred));
});
