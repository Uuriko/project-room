// PRODUCT-200 RELIABILITY A8 — invariant "reopening shows committed state":
// PROJECTION REBUILD PARITY.
//
// The read model must equal committed state after a rebuild. The scenario
// drives one work claim through create/update/release/reclaim, snapshots the
// live read model (store.room), then triggers store.rebuildProjection and
// asserts deep-equal — on both the full-history path and the checkpoint+tail
// path. It also proves the comparator is sensitive: a corrupted projection
// row must make the parity check FAIL (not pass silently), and a stale
// checkpoint (#2065's hardened case, merged) must fail the audit until the
// stale accelerator row is dropped, after which parity is restored.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const command = (type, data) => ({ id: randomUUID(), type, data });

function fixture(t, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), "room-claim-parity-"));
  const filename = join(directory, "room.sqlite");
  let now = Date.now();
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom(roomId));
  const keys = { owner: store.issueAccessKey(roomId, "owner") };
  for (const id of ["a", "b"]) {
    store.command(keys.owner, roomId, command(T.MEMBER_ADDED, {
      memberId: id, displayName: id, kind: "agent", accountableHumanId: "owner",
      permissions: ["accept_work", "complete_work", "write_external"],
    }));
    setTier(store.db, roomId, id, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    keys[id] = store.issueAccessKey(roomId, id);
  }
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, filename, keys, advance: ms => { now += ms; } };
}

// Drive one claim through create / update / release / reclaim / complete.
function driveClaimLifecycle({ store, keys, advance }, roomId = "commons") {
  const send = (key, type, data) => store.command(key, roomId, command(type, data));
  const item = () => store.room(roomId).state.workItems.w1;
  const scope = () => ({
    repository: "test/repo", ref: "draft", paths: ["src/**"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const rev = () => item().revision;
  // create
  send(keys.owner, T.WORK_PROPOSED, { workItemId: "w1", title: "parity work",
    definitionOfDone: "rebuild equals live", accountableMemberId: "a", mode: "write",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  send(keys.a, T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: 0 });
  // acquire
  send(keys.a, T.CLAIM_ACQUIRED, { workItemId: "w1", expectedRevision: rev(), ...scope() });
  assert.equal(item().claim.status, "active");
  // update
  send(keys.a, T.WORK_STARTED, { workItemId: "w1", expectedRevision: rev() });
  send(keys.a, T.WORK_BLOCKED, { workItemId: "w1", expectedRevision: rev(), reason: "waiting on ci", nextAction: "retry" });
  send(keys.a, T.WORK_BLOCKER_RESOLVED, { workItemId: "w1", expectedRevision: rev(), resolution: "ci green" });
  // renew (with a public progress check-in, per the lease-renewal rule; the
  // check-in must be newer than the lease start, so advance the clock)
  advance(1000);
  send(keys.a, T.MESSAGE_POSTED, { messageId: "progress-1", body: "Still on src/**" });
  advance(1000);
  send(keys.a, T.CLAIM_RENEWED, { workItemId: "w1", expectedRevision: rev(),
    progressMessageId: "progress-1", expiresAt: new Date(Date.now() + 600000).toISOString() });
  assert.equal(item().claim.renewals, 1);
  // release
  send(keys.a, T.CLAIM_RELEASED, { workItemId: "w1", expectedRevision: rev() });
  assert.equal(item().claim.status, "released");
  // reclaim
  send(keys.a, T.CLAIM_ACQUIRED, { workItemId: "w1", expectedRevision: rev(), ...scope() });
  assert.equal(item().claim.status, "active");
  // complete (live path requires signed external evidence)
  const signEvidence = makeTestSigner(store);
  send(keys.a, T.WORK_COMPLETED, { workItemId: "w1", expectedRevision: rev(),
    summary: "parity scenario done", nextAction: "none",
    evidenceUrl: "https://example.invalid/parity", evidenceVersion: "v1",
    signedEvidence: signEvidence() });
  assert.equal(item().state, "completed");
  return store.room(roomId).sequence;
}

// A plain deep copy so the frozen live read and the frozen rebuild compare
// as pure values.
const snapshot = room => JSON.parse(JSON.stringify({ sequence: room.sequence, state: room.state }));

function assertParity(store, roomId, label) {
  const live = snapshot(store.room(roomId));
  const rebuilt = snapshot(store.rebuildProjection(roomId));
  assert.deepEqual(rebuilt, live, `${label}: rebuilt read model must deep-equal the live read model`);
}

test("rebuild parity after a full claim lifecycle (full-history path, no checkpoint)", t => {
  const f = fixture(t);
  driveClaimLifecycle(f);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM projection_checkpoints").get().n, 0,
    "fixture precondition: no checkpoint row, so this exercises the full-history replay");
  assertParity(f.store, "commons", "full-history");
  // The read-only audit's live-vs-rebuilt comparison is the production gate.
  assert.doesNotThrow(() => auditRecovery(f.store), "auditRecovery must pass on the healthy store");
});

test("rebuild parity on the checkpoint+tail path", t => {
  const f = fixture(t);
  const head = driveClaimLifecycle(f);
  // A valid checkpoint mid-history: the store replays checkpoint + tail.
  const at = head - 3;
  const partial = f.store.rebuildProjection("commons", at);
  assert.equal(partial.sequence, at);
  f.store.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)")
    .run("commons", at, JSON.stringify(partial.state));
  assertParity(f.store, "commons", "checkpoint+tail");
  assert.doesNotThrow(() => auditRecovery(f.store), "auditRecovery must pass with a valid checkpoint");
});

test("a corrupted projection row is DETECTED by the parity comparison (fail-first)", t => {
  const f = fixture(t);
  driveClaimLifecycle(f);
  // Operator-level damage in this isolated fixture only: flip the claim
  // status in the stored projection row without touching the event log.
  const row = f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const tampered = JSON.parse(row);
  tampered.workItems.w1.claim.status = "released";
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(tampered));
  // Fresh store: no projection cache, so room() reads the tampered row.
  const fresh = new RoomStore(f.filename);
  t.after(() => fresh.close());
  const live = snapshot(fresh.room("commons"));
  const rebuilt = snapshot(fresh.rebuildProjection("commons"));
  assert.equal(live.state.workItems.w1.claim.status, "released", "the live read shows the tampered row");
  assert.equal(rebuilt.state.workItems.w1.claim.status, "active", "the rebuild replays the event log, not the row");
  assert.notDeepEqual(rebuilt, live, "parity comparison must DETECT the divergence, not pass silently");
  assert.throws(() => auditRecovery(fresh), /operator reconciliation/,
    "the read-only audit fails closed on the divergence");
});

test("rebuild parity is restored after a stale checkpoint is dropped (#2065 follow-through)", t => {
  const f = fixture(t);
  driveClaimLifecycle(f);
  const head = f.store.room("commons").sequence;
  // #2065 (merged) hardens auditRecovery against a checkpoint whose sequence
  // outruns its content. Here: capture that stale state, then repair by
  // dropping the stale accelerator row and assert the invariant is restored.
  const stale = f.store.rebuildProjection("commons", head - 4);
  f.store.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)")
    .run("commons", head, JSON.stringify(stale.state));
  const fresh = new RoomStore(f.filename);
  t.after(() => fresh.close());
  assert.notDeepEqual(
    snapshot(fresh.rebuildProjection("commons")).state.workItems,
    snapshot(fresh.room("commons")).state.workItems,
    "a stale checkpoint makes the rebuild diverge: the damage is visible");
  assert.throws(() => auditRecovery(fresh), /operator reconciliation/,
    "the #2065 fail-closed gate fires on the stale checkpoint");
  // Repair: drop the stale accelerator row. The event log is the source of
  // truth, so the next rebuild replays the full history and parity returns.
  fresh.db.prepare("DELETE FROM projection_checkpoints WHERE room_id='commons'").run();
  assertParity(fresh, "commons", "post-repair full-history");
  assert.doesNotThrow(() => auditRecovery(fresh), "auditRecovery must pass again after the repair");
});
