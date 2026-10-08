// QA200-MUT-20 Probe B hardening: stale projection_checkpoints rows.
//
// A checkpoint whose sequence outruns its content (sequence claims the head,
// content is an older snapshot) makes rebuildProjection return a silently
// stale projection at the head sequence — the replay trusts the snapshot and
// finds no events after it. The fail-closed gate is auditRecovery's
// live-vs-rebuilt comparison: it must throw, and the read-only audit must not
// repair the source. No existing test covered the stale-content checkpoint
// (recovery.test.js fault-injects the projection and the event envelope, and
// its fixture drops projection_checkpoints entirely).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-stale-checkpoint-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  const post = (id, body) => store.command(key, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: id, body } });
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, post };
}

test("a checkpoint whose sequence outruns its content fails closed at audit", t => {
  const { store, post } = fixture(t);
  post("m1", "one"); post("m2", "two");
  const stale = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  post("m3", "three"); post("m4", "four"); post("m5", "five");
  const head = store.room("commons").sequence;
  // Operator-level damage in this isolated fixture only: the checkpoint
  // claims the head sequence but holds the older snapshot.
  store.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)")
    .run("commons", head, stale);
  const live = store.room("commons").state.messages.map(message => message.id);
  const rebuilt = store.rebuildProjection("commons");
  assert.deepEqual(rebuilt.state.messages.map(message => message.id), ["m1", "m2"],
    "the rebuild trusts the stale checkpoint and returns old state at the head sequence");
  assert.notDeepEqual(rebuilt.state.messages.map(message => message.id), live,
    "live and rebuilt diverge: the audit's comparison is the gate that must catch it");
  const before = store.db.prepare("SELECT total_changes() n").get().n;
  assert.throws(() => auditRecovery(store), /operator reconciliation/);
  assert.equal(store.db.prepare("SELECT total_changes() n").get().n, before,
    "the read-only audit repairs nothing");
});

test("a checkpoint claiming a future sequence fails closed at audit", t => {
  const { store, post } = fixture(t);
  post("m1", "one");
  const projection = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const head = store.room("commons").sequence;
  store.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)")
    .run("commons", head + 10, projection);
  // Fail-closed either way: _replayRoom refuses a boundary that predates the
  // retained checkpoint, and the checkpoint bounds check would also fire.
  assert.throws(() => auditRecovery(store));
});
