// B-4' Phase 0 slice 4 (redesign council Appendix D §D.1, §4.2 orphan):
// the board row gains `accountableMemberId` (string|null), verbatim from
// the work item. It is distinct from the claimer `owner`: on an
// accepted-but-unclaimed item the board row had `owner: null` and the
// accountable member — who needs-me, reminders and wakes address — was
// lost (step-0 record §4.2, measured). Owner derivation is untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { boardClaimForWorkItem, planWorkItemBoardBackfill } from "../server/work-item-board.mjs";
import { workOf } from "../server/work-claims.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workitems-accountable-"));
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

test("slice4 fate: the §4.2 measured orphan — accepted-unclaimed row has accountableMemberId set while owner stays null", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "orphan-1", title: "Orphaned accountability", definitionOfDone: "done",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "orphan-1");
  const row = f.board("orphan-1");
  assert.equal(row.state, "unclaimed");
  assert.equal(row.owner, null);
  assert.equal(row.accountableMemberId, "worker");
});

test("slice4: a claimed row keeps owner = claim holder, distinct from accountableMemberId when they differ (pure mapping)", () => {
  const T0 = "2026-10-01T00:00:00.000Z";
  const H = 3600e3;
  const at = ms => new Date(Date.parse(T0) + ms).toISOString();
  const item = {
    id: "task-diff", title: "Delegated claim", state: "working", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: "done", labels: [], mode: "write", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, supersededBy: null,
    claim: { holderId: "claimer-x", repository: "Uuriko/project-room", ref: "main", paths: ["server/**"], status: "active", acquiredAt: at(2 * H), expiresAt: at(30 * H) },
  };
  const row = boardClaimForWorkItem(item, null, { nowMs: Date.parse(T0) + 10 * H });
  assert.equal(row.state, "in_progress");
  assert.equal(row.owner, "claimer-x");
  assert.equal(row.accountableMemberId, "worker");
  assert.notEqual(row.owner, row.accountableMemberId);
});

test("slice4 registry round-trip: accountableMemberId survives the real SQLite codec; workOf validates it", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "acct-rt", title: "Round trip", definitionOfDone: "done",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "acct-rt");
  const row = f.board("acct-rt");
  assert.equal(row.accountableMemberId, "worker");
  assert.equal(workOf(row).accountableMemberId, "worker");
  assert.equal(workOf({ id: "legacy-1", title: "Legacy" }).accountableMemberId, null);
  assert.throws(() => workOf({ id: "bad-1", accountableMemberId: 42 }), /accountableMemberId must be 1\.\.128 characters or null/);
  assert.throws(() => workOf({ id: "bad-2", accountableMemberId: "x".repeat(129) }), /accountableMemberId must be 1\.\.128 characters or null/);
});

test("slice4 phantom: a successor phantom card carries accountableMemberId null", () => {
  const T0 = "2026-10-01T00:00:00.000Z";
  const item = {
    id: "old-1", title: "Old", state: "superseded", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: "done", labels: [], mode: "read", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, claim: null, supersededBy: "new-1",
  };
  const events = [{ id: "ev-1", type: "work.superseded", actorId: "owner", at: T0, data: { workItemId: "old-1", supersededByWorkItemId: "new-1", reason: "replaced" } }];
  const { rows } = planWorkItemBoardBackfill({ items: [item], events, existing: new Map(), nowMs: Date.parse(T0) });
  const phantom = rows.get("new-1");
  assert.ok(phantom, "phantom successor card exists");
  assert.equal(phantom.accountableMemberId, null);
});
