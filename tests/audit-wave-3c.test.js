/**
 * audit-wave-3c.test.js — regression tests for audit wave 3C findings:
 * M-7 (collab authorization), M-8 (memory-ahead-of-disk rollback), M-29/M-30
 * (subscriber/listener isolation), M-31 (duplicate room ids in DM restore),
 * M-46 (persist-before-notify in owner-alerts dispatch).
 *
 * Each test fails on the pre-fix code for the intended reason and passes
 * after the owner-boundary repair. Run with:
 *   TMPDIR=<worktree>/.tmp node --test tests/audit-wave-3c.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// ---------------------------------------------------------------------------
// Storage doubles
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M-29: handoff-store subscriber isolation
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// M-30: dm-room-wiring listener isolation
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// M-31: dm-room-wiring restore rejects duplicate room ids
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// M-46: owner-alerts persist-before-notify
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M-8: per-store write-failure rollback
// ---------------------------------------------------------------------------








// ---------------------------------------------------------------------------
// M-8: collab store evicts cached journals after a failed mutation
// ---------------------------------------------------------------------------

function collabHarness(t) {
  const directory = mkdtempSync(join(tmpdir(), "audit-wave-3c-collab-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, collab: store.collab };
}

test("M-8: a refreshed draft lock still replays after a failed mutation evicts the cache", (t) => {  const { store, collab } = collabHarness(t);
  const agent = { kind: "agent", id: "agent-a" };
  const first = collab.acquireDraftLock("commons", "thread-1", agent);
  const refreshed = collab.acquireDraftLock("commons", "thread-1", agent);
  assert.equal(refreshed.duplicate, true);
  assert.equal(refreshed.lock.lockId, first.lock.lockId);
  // Break the write path: the journal runs for thread-2, the INSERT fails,
  // and the room cache is evicted. The next read must replay the refreshed
  // thread-1 lock from the database — the refresh rewrote the row with an
  // empty id sequence, which replay must still handle.
  store.db.exec(`CREATE TRIGGER fail_lock_insert BEFORE INSERT ON collab_draft_locks
    BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
  assert.throws(() => collab.acquireDraftLock("commons", "thread-2", agent), /simulated disk failure/);
  store.db.exec("DROP TRIGGER fail_lock_insert");
  const detected = collab.detectDraftLock("commons", "thread-1", { kind: "agent", id: "agent-b" });
  assert.equal(detected.collision, true);
  assert.equal(detected.holders[0].id, "agent-a");
  // thread-2 was never persisted: no phantom lock.
  const none = collab.detectDraftLock("commons", "thread-2", { kind: "agent", id: "agent-b" });
  assert.equal(none.collision, false);
});

test("M-8: a same-instant refresh still replays (empty id sequence falls back to the lockId)", (t) => {
  // With a frozen clock the refresh lands in the same instant as the
  // original acquire: the refresh rewrote the row with an empty id
  // sequence, which replay must seed from the persisted lockId.
  const directory = mkdtempSync(join(tmpdir(), "audit-wave-3c-collab-"));
  const frozen = 1790000000000;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => frozen });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const collab = store.collab;
  const agent = { kind: "agent", id: "agent-a" };
  const first = collab.acquireDraftLock("commons", "thread-1", agent);
  const refreshed = collab.acquireDraftLock("commons", "thread-1", agent);
  assert.equal(refreshed.duplicate, true);
  assert.equal(refreshed.lock.lockId, first.lock.lockId);
  store.db.exec(`CREATE TRIGGER fail_lock_insert BEFORE INSERT ON collab_draft_locks
    BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
  assert.throws(() => collab.acquireDraftLock("commons", "thread-2", agent), /simulated disk failure/);
  store.db.exec("DROP TRIGGER fail_lock_insert");
  const detected = collab.detectDraftLock("commons", "thread-1", { kind: "agent", id: "agent-b" });
  assert.equal(detected.collision, true);
  assert.equal(detected.holders[0].id, "agent-a");
});

test("M-8: a failed collab mutation does not leave the cached journal ahead of the database", (t) => {
  const { store, collab } = collabHarness(t);
  const before = collab.assignThread("commons", "thread-1", { kind: "agent", id: "agent-a" },
    { by: { kind: "human", id: "owner" } });
  assert.equal(before.record.status, "assigned");
  // Break the database write path (the table and its thread-1 row survive).
  store.db.exec(`CREATE TRIGGER fail_collab_insert BEFORE INSERT ON collab_assignments
    BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
  assert.throws(() => collab.assignThread("commons", "thread-2", { kind: "agent", id: "agent-a" },
    { by: { kind: "human", id: "owner" } }), /./);
  store.db.exec("DROP TRIGGER fail_collab_insert");
  // The next read must replay from the database, which holds only thread-1 —
  // no phantom thread-2 assignment from the failed mutation's journal.
  const listed = collab.listAssignments("commons");
  assert.equal(listed.length, 1, `expected 1 assignment, saw ${listed.length}`);
  assert.equal(listed[0].threadId, "thread-1");
});

// ---------------------------------------------------------------------------
// M-7(b): releaseAssignment authorization
// ---------------------------------------------------------------------------

test("M-7(b): an unrelated agent cannot release someone else's assignment", (t) => {
  const { collab } = collabHarness(t);
  const { assignmentId } = collab.assignThread("commons", "thread-1", { kind: "agent", id: "agent-a" },
    { by: { kind: "human", id: "owner" } });
  let forbidden = null;
  try {
    collab.releaseAssignment("commons", assignmentId, { by: { kind: "agent", id: "agent-b" } });
  } catch (e) { forbidden = e; }
  assert.ok(forbidden, "expected releaseAssignment to throw");
  assert.equal(forbidden.code, "assign_forbidden");
  assert.equal(collab.listAssignments("commons")[0].status, "assigned");
});

test("M-7(b): the assignee, the assigner, and the room owner can release", (t) => {
  const { collab } = collabHarness(t);
  for (const [threadId, releaser] of [
    ["thread-a", { kind: "agent", id: "agent-a" }],   // assignee
    ["thread-b", { kind: "human", id: "owner" }],     // assigner
    ["thread-c", { kind: "human", id: "owner" }],     // owner (also assigner here)
  ]) {
    const { assignmentId } = collab.assignThread("commons", threadId, { kind: "agent", id: "agent-a" },
      { by: { kind: "human", id: "owner" } });
    const released = collab.releaseAssignment("commons", assignmentId, { by: releaser });
    assert.equal(released.record.status, "released", `releaser ${releaser.id} on ${threadId}`);
  }
});

// ---------------------------------------------------------------------------
// M-7(c): transitionHandoff authorization
// ---------------------------------------------------------------------------

function handoffHarness(t) {
  const { store, collab } = collabHarness(t);
  const accountId = "acct-wave-3c";
  store.createAccount(accountId, "test");
  const makeHandoff = (threadId) => store.handoffs.create(accountId,
    {
      threadId, channel: "room", sourceIds: [threadId],
      sender: { id: "agent-a", label: "agent-a" },
      subject: "handoff", occurredAt: new Date(1_000_000).toISOString(),
      sla: null, triage: { action: "needs_human", reasons: ["test"] },
      summary: "s", openQuestions: null, pendingActions: null, excerpt: null,
    },
    { from: "agent-a", to: "agent-b", roomId: "commons", recordRoom: "commons" }).receipt.handoffId;
  return { store, collab, accountId, makeHandoff };
}

test("M-7(c): a third party cannot move someone else's handoff", (t) => {
  const { collab, accountId, makeHandoff } = handoffHarness(t);
  const handoffId = makeHandoff("thread-h1");
  const scope = { accountId, roomId: null };
  let forbidden = null;
  try {
    collab.transitionHandoff(scope, handoffId, "accepted",
      { by: "agent-c", roomId: "commons" });
  } catch (e) { forbidden = e; }
  assert.ok(forbidden, "expected transitionHandoff to throw");
  assert.equal(forbidden.code, "handoff_forbidden");
  const [handoff] = collab.listHandoffs(scope, {});
  assert.equal(handoff.status, "open");
});

test("M-7(c): the handoff sender, recipient, and room owner can transition", (t) => {
  const { collab, accountId, makeHandoff } = handoffHarness(t);
  const scope = { accountId, roomId: null };
  // Recipient accepts.
  const accepted = collab.transitionHandoff(scope, makeHandoff("thread-h2"), "accepted",
    { by: "agent-b", roomId: "commons" });
  assert.equal(accepted.status, "accepted");
  // Sender releases their own handoff.
  const released = collab.transitionHandoff(scope, makeHandoff("thread-h3"), "released",
    { by: "agent-a", roomId: "commons" });
  assert.equal(released.status, "released");
  // Owner moves it through the full lifecycle.
  const ownerHandoff = makeHandoff("thread-h4");
  collab.transitionHandoff(scope, ownerHandoff, "accepted",
    { by: "owner", roomId: "commons" });
  const ownerDone = collab.transitionHandoff(scope, ownerHandoff, "completed",
    { by: "owner", roomId: "commons" });
  assert.equal(ownerDone.status, "completed");
});

test("M-7(c): an agent acting under its linked identity id can transition its own handoff", (t) => {
  const { store, collab, accountId } = handoffHarness(t);
  // A real agent identity whose id names the handoff recipient; the caller
  // arrives as the linked member id.
  const identity = store.identities.create("Agent B");
  const handoffId = makeHandoffWithTo("thread-h5", identity.identityId);
  store.db.prepare(
    "INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("commons", identity.identityId, "agent-b-member", store.now());
  const scope = { accountId, roomId: null };
  const accepted = collab.transitionHandoff(scope, handoffId, "accepted",
    { by: "agent-b-member", roomId: "commons" });
  assert.equal(accepted.status, "accepted");

  function makeHandoffWithTo(threadId, to) {
    return store.handoffs.create(accountId,
      {
        threadId, channel: "room", sourceIds: [threadId],
        sender: { id: "agent-a", label: "agent-a" },
        subject: "handoff", occurredAt: new Date(1_000_000).toISOString(),
        sla: null, triage: { action: "needs_human", reasons: ["test"] },
        summary: "s", openQuestions: null, pendingActions: null, excerpt: null,
      },
      { from: "agent-a", to, roomId: "commons", recordRoom: "commons" }).receipt.handoffId;
  }
});

test("L-P2-13: transitionHandoff permission check survives the 500-cap list limit", (t) => {
  const { store, collab } = collabHarness(t);
  const accountId = "acct-wave-3c-cap";
  store.createAccount(accountId, "test");
  const mk = (threadId) => store.handoffs.create(accountId,
    {
      threadId, channel: "room", sourceIds: [threadId],
      sender: { id: "agent-a", label: "agent-a" },
      subject: "handoff", occurredAt: new Date(1_000_000).toISOString(),
      sla: null, triage: { action: "needs_human", reasons: ["test"] },
      summary: "s", openQuestions: null, pendingActions: null, excerpt: null,
    },
    { from: "agent-a", to: "agent-b", roomId: "commons", recordRoom: "commons" }).receipt.handoffId;
  const targetId = mk("thread-target");
  for (let i = 0; i < 500; i++) mk(`thread-fill-${i}`);
  // Age the target past the list's ORDER BY created_at DESC LIMIT 500 cap.
  store.db.prepare("UPDATE inbox_handoffs SET created_at=? WHERE handoff_id=?").run(1, targetId);
  const listed = collab.listHandoffs({ accountId, roomId: null }, {});
  assert.equal(listed.length, 500, "list is capped at 500");
  assert.ok(!listed.some(h => h.handoffId === targetId), "target is past the cap");
  // A third party must still be refused — the permission check may not be
  // skipped just because the handoff fell off the capped list.
  const scope = { accountId, roomId: null };
  let forbidden = null;
  try {
    collab.transitionHandoff(scope, targetId, "accepted", { by: "agent-c", roomId: "commons" });
  } catch (e) { forbidden = e; }
  assert.ok(forbidden, "expected transitionHandoff to throw for a past-the-cap handoff");
  assert.equal(forbidden.code, "handoff_forbidden");
  // And the handoff is untouched.
  const row = store.db.prepare("SELECT status FROM inbox_handoffs WHERE handoff_id=?").get(targetId);
  assert.equal(row.status, "open");
});

// ---------------------------------------------------------------------------
// M-7(c)/L-P2-13: the room-scoped permission lookup branch
// ---------------------------------------------------------------------------

test("M-7(c): a room-scoped scope still refuses a third-party transition", (t) => {
  const { store, collab, accountId, makeHandoff } = handoffHarness(t);
  // resolveHandoffAccount's owner-account path yields { accountId, roomId }
  // with roomId non-null, so the permission lookup runs the JOIN branch
  // against inbox_handoff_rooms. Existing tests only exercise the
  // account-scoped branch; the journal's transition enforces no from/to
  // parties of its own, so a silently-missed lookup here would let any
  // caller move someone else's handoff.
  const scope = { accountId, roomId: "commons" };
  const thirdId = makeHandoff("thread-rs-third");
  let forbidden = null;
  try {
    collab.transitionHandoff(scope, thirdId, "accepted", { by: "agent-c", roomId: "commons" });
  } catch (e) { forbidden = e; }
  assert.ok(forbidden, "expected transitionHandoff to throw for a third party under a room-scoped scope");
  assert.equal(forbidden.code, "handoff_forbidden");
  const untouched = store.db.prepare("SELECT status FROM inbox_handoffs WHERE handoff_id=?").get(thirdId);
  assert.equal(untouched.status, "open");
  // The recipient can still move it through the same room-scoped path.
  const accepted = collab.transitionHandoff(scope, makeHandoff("thread-rs-recipient"), "accepted",
    { by: "agent-b", roomId: "commons" });
  assert.equal(accepted.status, "accepted");
});
