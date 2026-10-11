// WAVE-500 guild 6, worker 13 — R36-1 read-path consistency slice (tests only).
//
// R36-1: resubmit() in server/inbox-approval.mjs returns a v2 record but never
// persists it (Tab owns the source fix — this file must not change behavior).
// This slice pins the NON-MUTATING observers through full mutation cycles:
// get(), list(), and the SQLite record_json must never disagree with each
// other or the returned record — through resubmit/requestEdits/approve
// cycles, and across journal close+reopen.
//
// Fail-first: on unfixed main these fail exactly at the resubmit steps (the
// journal still serves the pre-resubmit record), while the requestEdits
// control (fixed by M-4) passes. After Tab's fix all must pass.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApprovalQueue } from "../server/inbox-approval.mjs";
import { InboxCollabStore } from "../server/inbox-collab-store.mjs";

const agent = { kind: "agent", id: "w13-agent", label: "Worker 13" };
const agentB = { kind: "agent", id: "w13-agent", label: "Worker 13" }; // same proposer id
const human = { kind: "human", id: "w13-human", label: "Reviewer" };
const draft1 = { subject: "v1", body: "original body" };
const draft2 = { subject: "v2", body: "revised body" };
const draft3 = { subject: "v3", body: "final body" };

let proposalSeq = 0;
const makeQueue = () => {
  let t = 0;
  return createApprovalQueue({ clock: () => (t += 100), id: () => `w13-p${++proposalSeq}` });
};

// Every observer must serve exactly what the mutation returned.
function assertReadConsistent(queue, proposalId, returned, step) {
  const viaGet = queue.get(proposalId);
  assert.deepEqual(viaGet, returned, `${step}: get() disagrees with the returned record`);
  const viaList = queue.list().find(r => r.proposalId === proposalId);
  assert.ok(viaList, `${step}: list() lost the proposal`);
  assert.deepEqual(viaList, returned, `${step}: list() disagrees with the returned record`);
  const viaFiltered = queue.list({ status: returned.status }).find(r => r.proposalId === proposalId);
  assert.ok(viaFiltered, `${step}: list({status:${returned.status}}) lost the proposal`);
  assert.deepEqual(viaFiltered, returned, `${step}: list({status}) disagrees with the returned record`);
}

test("R36-1 readpath: get()/list() agree with the returned record after resubmit", () => {
  const queue = makeQueue();
  const proposed = queue.propose("thread:1", { draft: draft1, byAgent: agent, channel: "email" });
  assertReadConsistent(queue, proposed.proposalId, proposed, "propose");
  const edited = queue.requestEdits(proposed.proposalId, { by: human, edits: "Soften the opening." });
  assertReadConsistent(queue, proposed.proposalId, edited, "requestEdits");
  const resubmitted = queue.resubmit(proposed.proposalId, { draft: draft2, byAgent: agentB });
  assert.equal(resubmitted.version, 2);
  assertReadConsistent(queue, proposed.proposalId, resubmitted, "resubmit");
});

test("R36-1 readpath: observers agree at every step of a multi-cycle flow", () => {
  const queue = makeQueue();
  const steps = [];
  const p = queue.propose("thread:1", { draft: draft1, byAgent: agent, channel: "email" });
  steps.push(["propose", p]);
  const e1 = queue.requestEdits(p.proposalId, { by: human, edits: "First pass notes." });
  steps.push(["requestEdits#1", e1]);
  const r1 = queue.resubmit(p.proposalId, { draft: draft2, byAgent: agentB });
  steps.push(["resubmit#1", r1]);
  const e2 = queue.requestEdits(p.proposalId, { by: human, edits: "Second pass notes." });
  steps.push(["requestEdits#2", e2]);
  const r2 = queue.resubmit(p.proposalId, { draft: draft3, byAgent: agentB });
  steps.push(["resubmit#2", r2]);
  const approved = queue.approve(p.proposalId, { by: human });
  steps.push(["approve", approved]);

  for (const [name, returned] of steps) assertReadConsistent(queue, p.proposalId, returned, name);

  assert.deepEqual(steps.map(([, r]) => r.version), [1, 1, 2, 2, 3, 3], "versions must advance on resubmit only");
  assert.deepEqual(steps.map(([, r]) => r.draft.body),
    ["original body", "original body", "revised body", "revised body", "final body", "final body"],
    "every observer must carry the latest resubmitted draft");
  assert.deepEqual(steps.map(([, r]) => r.requestedEdits === null ? null : r.requestedEdits.edits),
    [null, "First pass notes.", null, "Second pass notes.", null, null],
    "requestedEdits clears on resubmit and is visible to every observer");
  assert.deepEqual(steps.map(([, r]) => r.history.length), [1, 2, 3, 4, 5, 6], "history grows monotonically");
  assert.equal(steps.at(-1)[1].status, "approved");
});

test("R36-1 readpath: list() stays consistent for untouched proposals while another cycles", () => {
  const queue = makeQueue();
  const a = queue.propose("thread:a", { draft: draft1, byAgent: agent, channel: "email" });
  const b = queue.propose("thread:b", { draft: draft1, byAgent: agent, channel: "email" });
  queue.requestEdits(a.proposalId, { by: human, edits: "Fix A." });
  const ra = queue.resubmit(a.proposalId, { draft: draft2, byAgent: agentB });
  assertReadConsistent(queue, a.proposalId, ra, "resubmit A");
  assertReadConsistent(queue, b.proposalId, b, "untouched B");
  assert.equal(queue.list().length, 2);
  assert.equal(queue.list({ status: "pending" }).length, 2);
});

// ---- SQLite-backed path: InboxCollabStore (write-through journal) ----

const makeSqliteStore = filename => {
  const db = new DatabaseSync(filename);
  let t = 0;
  return {
    db,
    now: () => (t += 100),
    transaction(fn) {
      db.exec("BEGIN");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    readTransaction: fn => fn(),
  };
};
const openCollab = filename => {
  const store = makeSqliteStore(filename);
  const collab = new InboxCollabStore(store);
  collab.execSchema();
  return { store, collab };
};
const recordJsonOf = (store, proposalId) => {
  const row = store.db.prepare("SELECT record_json, status FROM collab_approvals WHERE proposal_id=?").get(proposalId);
  assert.ok(row, "collab_approvals row missing");
  return { record: JSON.parse(row.record_json), status: row.status };
};

// record_json, the returned record, and the journal-backed listApprovals
// must all serve the same record.
function assertStoreConsistent(collab, store, roomId, proposalId, returned, step) {
  const { record, status } = recordJsonOf(store, proposalId);
  assert.deepEqual(record, returned, `${step}: SQLite record_json disagrees with the returned record`);
  assert.equal(status, returned.status, `${step}: status column disagrees with the returned record`);
  const viaList = collab.listApprovals(roomId).find(r => r.proposalId === proposalId);
  assert.ok(viaList, `${step}: listApprovals lost the proposal`);
  assert.deepEqual(viaList, returned, `${step}: listApprovals (journal) disagrees with the returned record`);
}

const ROOM = "w13-room";

test("R36-1 readpath (store): requestEdits persists to every observer — control", () => {
  const { store, collab } = openCollab(":memory:");
  const proposed = collab.proposeDraft(ROOM, "thread:1", { draft: draft1, byAgent: agent, channel: "email" });
  assertStoreConsistent(collab, store, ROOM, proposed.proposalId, proposed, "proposeDraft");
  const edited = collab.decideApproval(ROOM, proposed.proposalId,
    { decision: "edit", by: human, editedBody: "Soften the opening." });
  assertStoreConsistent(collab, store, ROOM, proposed.proposalId, edited, "decideApproval(edit)");
  store.db.close();
});

test("R36-1 readpath (store): resubmit keeps record_json, listApprovals and the returned record in agreement", () => {
  const { store, collab } = openCollab(":memory:");
  const proposed = collab.proposeDraft(ROOM, "thread:1", { draft: draft1, byAgent: agent, channel: "email" });
  assertStoreConsistent(collab, store, ROOM, proposed.proposalId, proposed, "proposeDraft");
  const edited = collab.decideApproval(ROOM, proposed.proposalId,
    { decision: "edit", by: human, editedBody: "Soften the opening." });
  assertStoreConsistent(collab, store, ROOM, proposed.proposalId, edited, "decideApproval(edit)");
  const resubmitted = collab.resubmitApproval(ROOM, proposed.proposalId, { draft: draft2, byAgent: agentB });
  assert.equal(resubmitted.version, 2);
  assertStoreConsistent(collab, store, ROOM, proposed.proposalId, resubmitted, "resubmitApproval");
  store.db.close();
});

test("R36-1 readpath (store): observers agree at every step of a multi-cycle flow", () => {
  const { store, collab } = openCollab(":memory:");
  const steps = [];
  const p = collab.proposeDraft(ROOM, "thread:1", { draft: draft1, byAgent: agent, channel: "email" });
  steps.push(["proposeDraft", p]);
  const e1 = collab.decideApproval(ROOM, p.proposalId, { decision: "edit", by: human, editedBody: "First pass." });
  steps.push(["edit#1", e1]);
  const r1 = collab.resubmitApproval(ROOM, p.proposalId, { draft: draft2, byAgent: agentB });
  steps.push(["resubmit#1", r1]);
  const e2 = collab.decideApproval(ROOM, p.proposalId, { decision: "edit", by: human, editedBody: "Second pass." });
  steps.push(["edit#2", e2]);
  const r2 = collab.resubmitApproval(ROOM, p.proposalId, { draft: draft3, byAgent: agentB });
  steps.push(["resubmit#2", r2]);
  const approved = collab.decideApproval(ROOM, p.proposalId, { decision: "approve", by: human });
  steps.push(["approve", approved]);

  for (const [name, returned] of steps) assertStoreConsistent(collab, store, ROOM, p.proposalId, returned, name);
  assert.deepEqual(steps.map(([, r]) => r.version), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(steps.map(([, r]) => r.draft.body),
    ["original body", "original body", "revised body", "revised body", "final body", "final body"]);
  store.db.close();
});

test("R36-1 readpath (store): agreement survives journal close+reopen", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w13-r361-"));
  const file = join(dir, "collab.sqlite");

  // Live phase: cycle a proposal, then close the journal.
  let proposalId;
  let resubmitted;
  {
    const { store, collab } = openCollab(file);
    const proposed = collab.proposeDraft(ROOM, "thread:1", { draft: draft1, byAgent: agent, channel: "email" });
    proposalId = proposed.proposalId;
    collab.decideApproval(ROOM, proposalId, { decision: "edit", by: human, editedBody: "Rework it." });
    resubmitted = collab.resubmitApproval(ROOM, proposalId, { draft: draft2, byAgent: agentB });
    store.db.close(); // journal closed; SQLite file is the source of truth now
  }

  // Reopen: a fresh journal set replays the persisted op log.
  const { store, collab } = openCollab(file);
  // Replay mismatch would throw here (replay asserts the rebuilt record
  // equals the persisted one); reaching this line means replay was clean.
  assertStoreConsistent(collab, store, ROOM, proposalId, resubmitted, "after close+reopen");

  // The reopened journal keeps serving the same record for later verdicts.
  const approved = collab.decideApproval(ROOM, proposalId, { decision: "approve", by: human });
  assertStoreConsistent(collab, store, ROOM, proposalId, approved, "approve after reopen");
  store.db.close();
});
