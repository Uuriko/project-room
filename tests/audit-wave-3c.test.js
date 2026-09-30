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
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandoffStore } from "../src/handoff-store.mjs";
import { createDMRooms } from "../src/dm-room-wiring.mjs";
import { createOwnerAlertDispatcher } from "../src/owner-alerts.mjs";
import { createUnifiedInboxStore } from "../src/unified-inbox-store.mjs";
import { createSnoozeStore } from "../src/snooze-store.mjs";
import { createTaskLifecycle } from "../src/task-lifecycle.mjs";
import { createThreadViewStore } from "../src/thread-view-store.mjs";
import { createMailboxSearchStore } from "../src/mailbox-search-store.mjs";
import { createInboxRuleStore } from "../src/inbox-rule-store.mjs";
import { DispatchJournal } from "../server/dispatch-journal.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// ---------------------------------------------------------------------------
// Storage doubles
// ---------------------------------------------------------------------------

/** Key/value storage whose writes always fail (M-8 rollback tests). */
function failingKeyValueStorage() {
  return {
    get() { return null; },
    set() { throw new Error("disk is full"); },
  };
}

/** Serialized storage (load/save) whose writes always fail. */
function failingSerializedStorage() {
  return {
    load() { return null; },
    save() { throw new Error("disk is full"); },
  };
}

/** Snooze's {read,write} storage whose writes always fail. */
function failingSnoozeStorage() {
  return {
    read() { return null; },
    write() { throw new Error("disk is full"); },
  };
}

// ---------------------------------------------------------------------------
// M-29: handoff-store subscriber isolation
// ---------------------------------------------------------------------------

test("M-29: a throwing handoff subscriber does not fail the committed transition or starve later subscribers", () => {
  const store = createHandoffStore({ storage: { load: () => null, save: () => {} } });
  const seen = [];
  store.subscribe(() => { throw new Error("subscriber blew up"); });
  store.subscribe((event) => { seen.push(event.type); });
  const handoff = store.propose(
    { fromAgent: "a", toAgent: "b", taskId: "t-1", summary: "s", context: {} }, "a");
  const result = store.accept(handoff.id, "b");
  assert.equal(result.state, "accepted");
  assert.deepEqual(seen, ["proposed", "accepted"]);
  assert.equal(store.get(handoff.id).state, "accepted");
});

// ---------------------------------------------------------------------------
// M-30: dm-room-wiring listener isolation
// ---------------------------------------------------------------------------

test("M-30: a throwing DM listener does not starve later listeners", () => {
  const dm = createDMRooms();
  const seen = [];
  dm.onEvent(() => { throw new Error("listener blew up"); });
  dm.onEvent((event) => { seen.push(event.type); });
  const room = dm.openDM("alice", "bob");
  assert.ok(seen.includes("room.opened"), `expected room.opened, saw ${JSON.stringify(seen)}`);
  assert.equal(room.agentA, "alice");
});

// ---------------------------------------------------------------------------
// M-31: dm-room-wiring restore rejects duplicate room ids
// ---------------------------------------------------------------------------

test("M-31: DM restore rejects a snapshot with two rooms sharing one id", () => {
  const dm = createDMRooms();
  const room = dm.openDM("alice", "bob");
  const snapshot = JSON.parse(dm.snapshot());
  // Same room id, different agent pair: the pair-key check alone cannot
  // catch this; without the id check the second room silently overwrites
  // the first.
  const dup = { ...snapshot.rooms[0], agentA: "carol", agentB: "dave" };
  snapshot.rooms.push(dup);
  assert.throws(
    () => dm.restore(JSON.stringify(snapshot)),
    (err) => err.code === "DM_CORRUPT_SNAPSHOT",
    "expected DM_CORRUPT_SNAPSHOT for duplicate room ids",
  );
  // The pre-existing room is untouched by the failed restore.
  assert.equal(dm.get(room.id).agentA, "alice");
});

// ---------------------------------------------------------------------------
// M-46: owner-alerts persist-before-notify
// ---------------------------------------------------------------------------

function raiseAndDispatchDeps({ storage, notifier }) {
  return {
    clock: () => 1_000_000,
    backoff: () => 0,
    sleep: () => Promise.resolve(),
    storage,
    notifier,
  };
}

test("M-46: the in-flight dispatch attempt is persisted before notify runs", async () => {
  const order = [];
  const storage = {
    load: () => null,
    save: () => { order.push("persist"); },
  };
  const notifier = {
    notify: async () => { order.push("notify"); },
  };
  const dispatcher = createOwnerAlertDispatcher(raiseAndDispatchDeps({ storage, notifier }));
  const alert = dispatcher.raise({ severity: "critical", title: "t", body: "b", source: "test" });
  order.length = 0; // ignore raise's persist; only dispatch's ordering matters
  await dispatcher.dispatch(alert.id);
  const firstPersist = order.indexOf("persist");
  const firstNotify = order.indexOf("notify");
  assert.ok(firstPersist !== -1, "expected a persist call");
  assert.ok(firstNotify !== -1, "expected a notify call");
  assert.ok(firstPersist < firstNotify, `persist must precede notify: ${JSON.stringify(order)}`);
});

test("M-46: a storage failure after a successful notify is a storage error, not a retried delivery", async () => {
  let writes = 0;
  const storage = {
    load: () => null,
    save: () => {
      writes += 1;
      // Writes: 1 = raise, 2 = in-flight attempt persist, 3 = post-notify
      // settle. Fail the post-notify write: the send already happened.
      if (writes > 2) throw new Error("disk is full");
    },
  };
  let notifyCalls = 0;
  const notifier = {
    notify: async () => { notifyCalls += 1; },
  };
  const dispatcher = createOwnerAlertDispatcher(raiseAndDispatchDeps({ storage, notifier }));
  const alert = dispatcher.raise({ severity: "critical", title: "t", body: "b", source: "test" });
  await assert.rejects(
    dispatcher.dispatch(alert.id),
    (err) => err.code === "OA_STORAGE_ERROR",
    "expected OA_STORAGE_ERROR, not OA_DELIVERY_FAILED",
  );
  assert.equal(notifyCalls, 1, "the alert must be sent exactly once");
  assert.equal(dispatcher.get(alert.id).attempts.length, 1, "no retry after a post-notify storage failure");
});

// ---------------------------------------------------------------------------
// M-8: per-store write-failure rollback
// ---------------------------------------------------------------------------

test("M-8: unified-inbox-store rolls back memory when the write fails", () => {
  const store = createUnifiedInboxStore({ storage: failingKeyValueStorage() });
  assert.throws(() => store.upsertMessage({
    from: "a", to: "b", subject: "s", body: "b", channel: "email", ts: 1_000_000,
  }), (err) => err.code === "UIS_STORAGE_ERROR");
  assert.equal(store.list().messages.length, 0);
});

test("M-8: snooze-store rolls back memory when the write fails", () => {
  const store = createSnoozeStore({ storage: failingSnoozeStorage(), clock: () => 1_000_000 });
  assert.throws(() => store.snooze("msg-1", 2_000_000), /disk is full/);
  assert.equal(store.list().length, 0);
});

test("M-8: task-lifecycle rolls back memory when the write fails", () => {
  const store = createTaskLifecycle({ storage: failingSerializedStorage() });
  assert.throws(() => store.create({ title: "do the thing" }), /disk is full/);
  assert.equal(store.list().length, 0);
});

test("M-8: thread-view-store rolls back memory when the write fails", () => {
  const store = createThreadViewStore({ storage: failingKeyValueStorage() });
  assert.throws(() => store.updateDraft("thread-1", "hello"),
    (err) => err.code === "TV_STORAGE_ERROR");
  assert.equal(store.getViewState("thread-1"), null);
});

test("M-8: mailbox-search-store rolls back memory when the write fails", () => {
  const store = createMailboxSearchStore({ storage: failingKeyValueStorage() });
  assert.throws(() => store.addDocument({
    from: "a", to: "b", subject: "s", body: "b", channel: "email",
  }), (err) => err.code === "MS_STORAGE_ERROR");
  assert.equal(store.documentCount(), 0);
});

test("M-8: inbox-rule-store rolls back memory when the write fails", () => {
  const store = createInboxRuleStore({ storage: failingSerializedStorage() });
  assert.throws(() => store.create({
    name: "boss mail", enabled: true, priority: 10,
    conditions: [{ field: "from", op: "contains", value: "boss@corp.com" }],
    actions: [{ type: "star" }],
  }), (err) => err.code === "IR_STORAGE");
  assert.equal(store.list().length, 0);
});

test("M-8: dispatch-journal rolls back in-memory records when the disk write fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "audit-wave-3c-journal-"));
  try {
    const path = join(directory, "dispatch.log");
    const journal = new DispatchJournal(path, { now: () => 1_000_000 });
    journal.append({ key: "job-a", state: "intended", jobId: "job-a" });
    assert.equal(journal.get("job-a").state, "intended");
    // Turn the journal path into a directory: the next appendFileSync throws.
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => journal.append({ key: "job-b", state: "intended", jobId: "job-b" }), /./);
    assert.equal(journal.get("job-b"), null, "failed append must not leave a memory record");
    assert.equal(journal.get("job-a").state, "intended", "earlier records must be untouched");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
