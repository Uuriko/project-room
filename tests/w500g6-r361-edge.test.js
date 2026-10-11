// WAVE-500 guild 6, worker 17 — edge-case fail-first tests around
// resubmit/approve (R36-1; Tab owns the fix, this file is tests only).
//
// R36-1 facets pinned here:
//  1. resubmit() must PERSIST the resubmitted record. Today it returns a
//     correct copy (bumped version, new draft, requestedEdits cleared) but
//     never stores it — get()/list() still show the old draft, the old
//     version, and stale requestedEdits (the mirror image of the M-4
//     requestEdits bug, which persisted its payload the same way).
//  2. approve() must bind to the resubmitted version: approve(id,
//     { by, version? }) fences on the version — stale or future versions
//     are approval_conflict (409) with detail { expected, actual }.
//     (Contract per g6-16's version-fencing slice, PR #2570; these tests
//     only exercise it in multi-cycle/edge contexts, not the single-cycle
//     cases #2570 already covers.)
//  3. resubmit on a terminal (approved/rejected) proposal is a clean
//     approval_transition (HTTP 409) with no state change.
//  4. replaying the persisted op log after a resubmit reproduces the same
//     observable state (journal level and collab-store level).
//  5. a full two-cycle run — resubmit→approve→reopen→resubmit→approve —
//     reaches v3 with a human reopen between the cycles.
//
// Assumed fix API (Tab's v2 patch; dpaste FGG4VEU2J had expired when read,
// so this is the reviewer's best reconstruction — see report):
//   queue.reopen(proposalId, { by }) — human-only; approved ->
//   changes_requested, journaled on the history. If Tab named or shaped it
//   differently, the (a) tests fail naming the missing piece.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ApprovalError, createApprovalQueue } from "../server/inbox-approval.mjs";
import { InboxCollabStore } from "../server/inbox-collab-store.mjs";
import { collabHttpError } from "../server/inbox-collab-routes.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const human = { kind: "human", id: "john", label: "John" };
const v1 = { subject: "Re: kickoff", body: "Sounds good — Tuesday?" };
const v2 = { subject: "Re: kickoff", body: "Softer opening — Tuesday?" };
const v3 = { subject: "Re: kickoff", body: "Third draft — Tuesday, 2pm?" };

const expectCode = (fn, code) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof ApprovalError, `expected ApprovalError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return error;
  }
  assert.fail(`expected ${code} but nothing threw`);
};
const expectConflict = (fn, expected, actual) => {
  const error = expectCode(fn, "approval_conflict");
  assert.ok(error.detail, "conflict must carry detail");
  assert.equal(error.detail.expected, expected);
  assert.equal(error.detail.actual, actual);
};
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };
const makeIds = prefix => { let n = 0; return () => `${prefix}-${++n}`; };
// Identical scripted clock/id sequences for journal-level replay comparisons.
const makeScripted = () => {
  const times = Array.from({ length: 64 }, (_, i) => 1000 * (i + 1));
  let ti = 0;
  return {
    clock: () => { assert.ok(ti < times.length, "scripted clock exhausted"); return times[ti++]; },
    id: makeIds("replay"),
  };
};
const propose = (queue, draft = v1) =>
  queue.propose("thread:1", { draft, byAgent: agent, channel: "email" });

// ---------------------------------------------------------------------------
// (a) two full cycles with a human reopen between them, reaching v3.
// ---------------------------------------------------------------------------

test("(a) resubmit→approve→reopen→resubmit→approve reaches v3 with a complete audit trail", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("a1") });
  const { proposalId } = propose(queue);
  queue.requestEdits(proposalId, { by: human, edits: "Soften the opening." });
  const second = queue.resubmit(proposalId, { draft: v2, byAgent: agent });
  assert.equal(second.version, 2);
  const approved2 = queue.approve(proposalId, { by: human, version: 2 });
  assert.equal(approved2.status, "approved");
  assert.equal(approved2.version, 2);

  // The reopen: a human sends the approved proposal back for another cycle.
  const reopened = queue.reopen(proposalId, { by: human });
  assert.equal(reopened.status, "changes_requested", "reopen returns the proposal to the edit loop");
  assert.equal(reopened.version, 2, "reopen never bumps the version — only resubmit does");
  assert.equal(reopened.requestedEdits, null);

  const third = queue.resubmit(proposalId, { draft: v3, byAgent: agent });
  assert.equal(third.version, 3);
  assert.deepEqual(third.draft, { subject: v3.subject, body: v3.body });
  assert.equal(third.requestedEdits, null);
  // The stored record — not just the return value — carries the new cycle.
  const stored = queue.get(proposalId);
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.draft, { subject: v3.subject, body: v3.body });
  assert.equal(stored.requestedEdits, null);

  const approved3 = queue.approve(proposalId, { by: human, version: 3 });
  assert.equal(approved3.status, "approved");
  assert.equal(approved3.version, 3);
  assert.deepEqual(approved3.draft, { subject: v3.subject, body: v3.body });
  assert.equal(queue.audit(proposalId).map(h => h.status).join(","),
    "pending,changes_requested,pending,approved,changes_requested,pending,approved");
});

test("(a) reopen is human-gated: an agent cannot reopen its own approved draft", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("a2") });
  const { proposalId } = propose(queue);
  queue.approve(proposalId, { by: human, version: 1 });
  expectCode(() => queue.reopen(proposalId, { by: agent }), "approval_not_human");
  assert.equal(queue.get(proposalId).status, "approved", "a refused reopen changes nothing");
});

test("(a) reopen refuses anything but an approved proposal; nothing changes", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("a3") });
  const pending = propose(queue);
  expectCode(() => queue.reopen(pending.proposalId, { by: human }), "approval_transition");
  queue.requestEdits(pending.proposalId, { by: human, edits: "x" });
  expectCode(() => queue.reopen(pending.proposalId, { by: human }), "approval_transition");
  assert.equal(queue.get(pending.proposalId).status, "changes_requested");
  const rejected = propose(queue);
  queue.reject(rejected.proposalId, { by: human, reason: "wrong thread" });
  expectCode(() => queue.reopen(rejected.proposalId, { by: human }), "approval_transition");
  assert.equal(queue.get(rejected.proposalId).status, "rejected");
});

test("(a) reopen on a fresh v1 approval starts a clean second cycle at v2", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("a4") });
  const { proposalId } = propose(queue);
  queue.approve(proposalId, { by: human, version: 1 });
  queue.reopen(proposalId, { by: human });
  const second = queue.resubmit(proposalId, { draft: v2, byAgent: agent });
  assert.equal(second.version, 2);
  assert.deepEqual(queue.get(proposalId).draft, { subject: v2.subject, body: v2.body });
  const approved = queue.approve(proposalId, { by: human, version: 2 });
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 2);
});

test("(a) the version fence holds across the reopen: a v2-bound approve cannot land on v3", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("a5") });
  const { proposalId } = propose(queue);
  queue.requestEdits(proposalId, { by: human, edits: "Soften it." });
  queue.resubmit(proposalId, { draft: v2, byAgent: agent });
  queue.approve(proposalId, { by: human, version: 2 });
  queue.reopen(proposalId, { by: human });
  queue.resubmit(proposalId, { draft: v3, byAgent: agent });
  // The human's v2 verdict is stale now that v3 is pending.
  expectConflict(() => queue.approve(proposalId, { by: human, version: 2 }), 2, 3);
  assert.equal(queue.get(proposalId).status, "pending", "the conflicted approve changes nothing");
  const approved = queue.approve(proposalId, { by: human, version: 3 });
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 3);
});

// ---------------------------------------------------------------------------
// (b) approve after resubmit binds the resubmitted version.
// ---------------------------------------------------------------------------

test("(b) approve after resubmit approves the new draft at the bumped version with edits cleared", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("b1") });
  const { proposalId } = propose(queue);
  queue.requestEdits(proposalId, { by: human, edits: "Soften the opening." });
  queue.resubmit(proposalId, { draft: v2, byAgent: agent });
  const approved = queue.approve(proposalId, { by: human, version: 2 });
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 2, "the approval binds the resubmitted version, not the stale v1");
  assert.deepEqual(approved.draft, { subject: v2.subject, body: v2.body },
    "the approval binds the resubmitted draft, not the superseded v1 draft");
  assert.equal(approved.requestedEdits, null, "requestedEdits stay cleared through the approval");
  // The stored record agrees with the returned one — the R36-1 persistence half.
  const stored = queue.get(proposalId);
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.draft, { subject: v2.subject, body: v2.body });
  assert.equal(stored.requestedEdits, null);
  assert.equal(queue.list({ status: "approved" })[0].version, 2);
});

// ---------------------------------------------------------------------------
// (c) resubmit on a terminal proposal: clean 409, no state change.
// ---------------------------------------------------------------------------

test("(c) resubmit on an approved proposal throws approval_transition and changes nothing", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("c1") });
  const { proposalId } = propose(queue);
  queue.approve(proposalId, { by: human, version: 1 });
  const before = queue.get(proposalId);
  expectCode(() => queue.resubmit(proposalId, { draft: v2, byAgent: agent }), "approval_transition");
  const after = queue.get(proposalId);
  assert.deepEqual(after, before, "a refused resubmit must not touch the stored record");
  assert.equal(after.status, "approved");
  assert.equal(after.history.length, before.history.length);
});

test("(c) resubmit on a rejected proposal throws approval_transition and changes nothing", () => {
  const queue = createApprovalQueue({ clock: fixedClock(), id: makeIds("c2") });
  const { proposalId } = propose(queue);
  queue.reject(proposalId, { by: human, reason: "wrong thread" });
  const before = queue.get(proposalId);
  expectCode(() => queue.resubmit(proposalId, { draft: v2, byAgent: agent }), "approval_transition");
  assert.deepEqual(queue.get(proposalId), before, "a refused resubmit must not touch the stored record");
});

test("(c) approval_transition maps to a clean HTTP 409, not a 500", () => {
  const mapped = collabHttpError(new ApprovalError("approval_transition", "A approved proposal cannot move to pending."));
  assert.ok(mapped, "the code must be mapped");
  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, "approval_transition");
});

// ---------------------------------------------------------------------------
// (d) the op log replays to the same observable state after a resubmit.
// ---------------------------------------------------------------------------

const replayOps = queue => {
  const { proposalId } = propose(queue);
  queue.requestEdits(proposalId, { by: human, edits: "Soften the opening." });
  return queue.resubmit(proposalId, { draft: v2, byAgent: agent });
};

test("(d) journal level: replaying propose→requestEdits→resubmit reproduces the reported state", () => {
  const first = createApprovalQueue(makeScripted());
  const reported = replayOps(first);
  assert.equal(reported.version, 2);
  const second = createApprovalQueue(makeScripted());
  replayOps(second);
  assert.deepEqual(second.get(reported.proposalId), reported,
    "the replayed observable state must equal the state the ops reported");
});

const makeCollab = db => {
  let now = 1000;
  const store = { db, now: () => (now += 1000), transaction: fn => fn(), readTransaction: fn => fn() };
  const collab = new InboxCollabStore(store);
  collab.execSchema();
  return collab;
};

test("(d) store level: op-log replay after a resubmit returns the same observable state", () => {
  const db = new DatabaseSync(":memory:");
  const roomId = "room-r361-edge";
  const collab = makeCollab(db);
  const proposed = collab.proposeDraft(roomId, "thread:1", { draft: v1, byAgent: agent, channel: "email" });
  collab.decideApproval(roomId, proposed.proposalId, { decision: "edit", by: human, editedBody: "Soften it." });
  const resubmitted = collab.resubmitApproval(roomId, proposed.proposalId, { draft: v2, byAgent: agent });
  assert.equal(resubmitted.status, "pending");
  assert.equal(resubmitted.version, 2);
  assert.equal(resubmitted.requestedEdits, null);

  // The persisted op log: three ops, and the record is the reported one.
  const row = db.prepare("SELECT ops_json, record_json FROM collab_approvals WHERE room_id=?").get(roomId);
  assert.equal(JSON.parse(row.ops_json).map(op => op.op).join(","), "propose,requestEdits,resubmit");
  assert.deepEqual(JSON.parse(row.record_json), resubmitted);

  // Simulate a restart: a fresh store over the same database replays the log.
  const replayed = makeCollab(db);
  const [record] = replayed.listApprovals(roomId);
  assert.deepEqual(record, resubmitted,
    "after replay the observable proposal must equal the state the resubmit reported");
  assert.equal(record.version, 2);
  assert.deepEqual(record.draft, { subject: v2.subject, body: v2.body });
  assert.equal(record.requestedEdits, null);
  db.close();
});
