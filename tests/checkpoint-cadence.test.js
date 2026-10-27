// S-09: checkpoint-on-write cadence.
//
// Before this change only three special writers ever wrote
// projection_checkpoints (a migration repair, event import, account
// deletion); ordinary rooms folded from event 1 on every rebuild. The
// acceptance priced for S-09 is a coverage read: after ordinary writes
// cross the cadence, every room's retained checkpoint is within
// PROJECTION_CHECKPOINT_INTERVAL (500) events of its head — coverage
// 100% within 500 of head — and the checkpoint is a valid replay base.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore, PROJECTION_CHECKPOINT_INTERVAL } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const INTERVAL = PROJECTION_CHECKPOINT_INTERVAL;

function fixture(t, roomIds = ["commons"]) {
  const directory = mkdtempSync(join(tmpdir(), "room-checkpoint-cadence-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  const keys = {};
  for (const roomId of roomIds) {
    store.initialize(initialRoom(roomId));
    keys[roomId] = store.issueAccessKey(roomId, "owner");
  }
  let n = 0;
  const post = roomId => {
    clock += 15000; // keep the flood guard's simulated refill ahead of the posts
    n += 1;
    return store.command(keys[roomId], roomId, { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: `m${n}`, body: `cadence message ${n}` } });
  };
  const postUntil = (roomId, headAtLeast) => { while (store.headSequence(roomId) < headAtLeast) post(roomId); };
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, post, postUntil };
}

test("ordinary writes checkpoint on the cadence: coverage is 100% within 500 of head", t => {
  const { store, post, postUntil } = fixture(t, ["commons", "side"]);
  // Below the first cadence point no checkpoint exists yet and none is owed:
  // a room's lag can only exceed the interval once its head passes it.
  postUntil("commons", INTERVAL - 1);
  assert.equal(store.checkpointCoverage("commons").checkpointSequence, null);

  // The write that crosses the cadence leaves a checkpoint at the head.
  post("commons");
  let coverage = store.checkpointCoverage("commons");
  assert.equal(coverage.checkpointSequence, coverage.sequence);
  assert.equal(coverage.lag, 0);

  // Writes below the next cadence point do not rewrite the checkpoint.
  const firstCheckpoint = coverage.checkpointSequence;
  postUntil("commons", firstCheckpoint + INTERVAL - 1);
  coverage = store.checkpointCoverage("commons");
  assert.equal(coverage.checkpointSequence, firstCheckpoint);
  assert.equal(coverage.lag, INTERVAL - 1);

  // A refused command commits nothing and advances no checkpoint.
  assert.throws(() => store.command("not-a-key", "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "nope", body: "nope" } }));
  assert.equal(store.checkpointCoverage("commons").checkpointSequence, firstCheckpoint);

  // Crossing the second cadence point advances the checkpoint again.
  post("commons");
  coverage = store.checkpointCoverage("commons");
  assert.equal(coverage.checkpointSequence, coverage.sequence);
  assert.ok(coverage.checkpointSequence >= firstCheckpoint + INTERVAL);

  // The priced acceptance, read across every room in the store after both
  // have crossed the cadence: coverage = 100% within 500 of head.
  postUntil("side", INTERVAL + 120);
  for (const roomId of ["commons", "side"]) {
    const read = store.checkpointCoverage(roomId);
    assert.notEqual(read.checkpointSequence, null, `${roomId} has a checkpoint`);
    assert.ok(read.lag < INTERVAL, `${roomId} checkpoint within ${INTERVAL} of head (lag ${read.lag})`);
  }
});

test("the cadence checkpoint is a valid replay base and matches the full fold", t => {
  const { store, postUntil } = fixture(t);
  postUntil("commons", INTERVAL * 2 + 37);
  const coverage = store.checkpointCoverage("commons");
  assert.ok(coverage.checkpointSequence >= INTERVAL * 2);

  // The recovery audit's live-vs-rebuilt comparison gates on the checkpoint
  // being an exact snapshot at its sequence: it must pass with the cadence
  // checkpoint in place.
  auditRecovery(store);

  const live = store.room("commons");
  const fromCheckpoint = store.rebuildProjection("commons");
  assert.equal(fromCheckpoint.sequence, live.sequence);
  assert.deepEqual(fromCheckpoint.state.messages.map(m => m.id), live.state.messages.map(m => m.id));

  // Dropping the checkpoint (the pre-S-09 state of every ordinary room)
  // folds from event 1 and must land on the same state.
  store.db.prepare("DELETE FROM projection_checkpoints WHERE room_id='commons'").run();
  const fromScratch = store.rebuildProjection("commons");
  assert.equal(fromScratch.sequence, fromCheckpoint.sequence);
  assert.deepEqual(fromScratch.state.messages.map(m => m.id), fromCheckpoint.state.messages.map(m => m.id));
});

test("the side-table append rail keeps the same checkpoint coverage", t => {
  const { store, keys, postUntil } = fixture(t);
  store.command(keys.commons, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "peer", displayName: "Peer", kind: "human", permissions: [] } });
  postUntil("commons", INTERVAL - 1);
  assert.equal(store.checkpointCoverage("commons").checkpointSequence, null);
  // dm.consent_changed has a reducer no-op, so the receipt replays clean
  // from any checkpoint (the appendSideTableEvent contract).
  store.appendSideTableEvent("commons", {
    id: randomUUID(), idempotencyKey: randomUUID(), roomId: "commons",
    type: T.DM_CONSENT_CHANGED, actorId: "owner", at: new Date().toISOString(),
    data: { requesterId: "owner", targetId: "peer", status: "approved" }
  });
  const coverage = store.checkpointCoverage("commons");
  assert.equal(coverage.sequence, INTERVAL);
  assert.equal(coverage.checkpointSequence, INTERVAL);
  assert.equal(coverage.lag, 0);
  assert.ok(keys.commons); // fixture keys issued (owner posts above used them)
});
