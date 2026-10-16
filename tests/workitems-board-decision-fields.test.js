// B-4' Phase 0 slice 2 (redesign council Appendix D §D.1, §4.2 orphans):
// the board row gains the decision-gate fields `ownerDecisionRequired`
// (boolean) and `humanDecisionMakerId` (string|null), carried verbatim
// from the work item's stored values — the same names and semantics the
// item fields have, so the #3342 decisions inbox can re-point at the
// board 1:1. Fate pins run against a real RoomStore; the registry
// round-trip goes through the real SQLite work-claims codec.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { boardClaimForWorkItem, planWorkItemBoardBackfill } from "../server/work-item-board.mjs";
import { workOf } from "../server/work-claims.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workitems-decision-fields-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-worker", type: "member.added", data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] } });
  const workerKey = store.issueAccessKey("commons", "worker");
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const item = id => store.room("commons").state.workItems[id];
  const mutate = (key, id, type, workItemId, data = {}) => send(key, id, type, { workItemId, expectedRevision: item(workItemId).revision, ...data });
  const board = id => store.workClaims.get("commons", id);
  return { store, ownerKey, workerKey, send, item, mutate, board };
}

test("slice2 fate: a decision-gated item's row carries both fields in every mapped state, including accepted-unclaimed (the §4.2 gap)", async (t) => {
  const f = fixture(t);
  const signEvidence = makeTestSigner(f.store);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "gated-1", title: "Gated", definitionOfDone: "decided and done",
    accountableMemberId: "worker", ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read",
  });
  // Proposed: no card yet (deliberate), so nothing to pin until acceptance.
  assert.equal(f.board("gated-1"), null);
  f.mutate(f.workerKey, "accept", "work.accepted", "gated-1");
  // Accepted-unclaimed is the measured §4.2 gap: the gate's addressee
  // existed only on the item. The board row now names it too.
  let row = f.board("gated-1");
  assert.equal(row.state, "unclaimed");
  assert.equal(row.ownerDecisionRequired, true);
  assert.equal(row.humanDecisionMakerId, "owner");

  f.mutate(f.workerKey, "start", "work.started", "gated-1");
  row = f.board("gated-1");
  assert.equal(row.state, "in_progress");
  assert.equal(row.ownerDecisionRequired, true);
  assert.equal(row.humanDecisionMakerId, "owner");

  f.mutate(f.workerKey, "block", "work.blocked", "gated-1", { reason: "waiting", nextAction: "decide" });
  row = f.board("gated-1");
  assert.equal(row.state, "blocked");
  assert.equal(row.ownerDecisionRequired, true);
  assert.equal(row.humanDecisionMakerId, "owner");

  f.mutate(f.workerKey, "resolve", "work.blocker_resolved", "gated-1", { resolution: "go" });
  f.mutate(f.workerKey, "start-2", "work.started", "gated-1");
  f.mutate(f.workerKey, "complete", "work.completed", "gated-1", { summary: "done", producerId: "worker", nextAction: "decide", signedEvidence: signEvidence() });
  row = f.board("gated-1");
  assert.equal(row.state, "done");
  assert.equal(row.ownerDecisionRequired, true);
  assert.equal(row.humanDecisionMakerId, "owner");
});

test("slice2 fate: a non-gated item's row carries false/null, never the room owner by recomputation", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "plain-1", title: "Plain", definitionOfDone: "done",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "plain-1");
  const row = f.board("plain-1");
  assert.equal(row.state, "unclaimed");
  assert.equal(row.ownerDecisionRequired, false);
  assert.equal(row.humanDecisionMakerId, null);
});

test("slice2 registry round-trip: both fields survive the real SQLite work-claims codec; workOf validates their shapes", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "gated-rt", title: "Gated RT", definitionOfDone: "done",
    accountableMemberId: "worker", ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "gated-rt");
  // store.workClaims.get IS the registry decode path (codec whitelist +
  // defaults), so a field that survives this read was registered in
  // WORK_CLAIM_FIELDS/WORK_CLAIM_DEFAULTS, not just in the mapping.
  const row = f.board("gated-rt");
  assert.equal(row.ownerDecisionRequired, true);
  assert.equal(row.humanDecisionMakerId, "owner");
  const validated = workOf(row);
  assert.equal(validated.ownerDecisionRequired, true);
  assert.equal(validated.humanDecisionMakerId, "owner");
  // Defaults for rows written before these fields existed.
  const legacy = workOf({ id: "legacy-1", title: "Legacy" });
  assert.equal(legacy.ownerDecisionRequired, false);
  assert.equal(legacy.humanDecisionMakerId, null);
  assert.throws(() => workOf({ id: "bad-1", ownerDecisionRequired: "yes" }), /ownerDecisionRequired must be a boolean/);
  assert.throws(() => workOf({ id: "bad-2", humanDecisionMakerId: 42 }), /humanDecisionMakerId must be 1\.\.128 characters or null/);
  assert.throws(() => workOf({ id: "bad-3", humanDecisionMakerId: "x".repeat(129) }), /humanDecisionMakerId must be 1\.\.128 characters or null/);
});

test("slice2 phantom: a successor phantom card carries the decision-gate defaults (false/null)", () => {
  const T0 = "2026-10-01T00:00:00.000Z";
  const item = {
    id: "old-1", title: "Old", state: "superseded", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: "owner",
    ownerDecisionRequired: true, independentVerificationRequired: false,
    definitionOfDone: "done", labels: [], mode: "read", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, claim: null, supersededBy: "new-1",
  };
  const events = [{ id: "ev-1", type: "work.superseded", actorId: "owner", at: T0, data: { workItemId: "old-1", supersededByWorkItemId: "new-1", reason: "replaced" } }];
  const { rows } = planWorkItemBoardBackfill({ items: [item], events, existing: new Map(), nowMs: Date.parse(T0) });
  const phantom = rows.get("new-1");
  assert.ok(phantom, "phantom successor card exists");
  assert.equal(phantom.ownerDecisionRequired, false);
  assert.equal(phantom.humanDecisionMakerId, null);
  // The superseded source row itself carries the item's stored gate values.
  const source = boardClaimForWorkItem(item, null, { nowMs: Date.parse(T0) });
  assert.equal(source.ownerDecisionRequired, true);
  assert.equal(source.humanDecisionMakerId, "owner");
});
