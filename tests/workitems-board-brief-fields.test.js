// B-4' Phase 0 slice 3a (redesign council Appendix D §D.1, §4.1 orphans):
// the board row gains the work brief — `definitionOfDone` and `mode`,
// both verbatim from the work item. §4.1 fate re-pin: the step-0 census
// asserted a sentinel definitionOfDone was ABSENT from the board row;
// this suite asserts the opposite — the sentinel is now PRESENT. (The
// step-0 census test itself lives in PR #3565, not on main; no test on
// main pinned the absence — the migration census pins item keys only.)
//
// Naming/cap choices (also recorded in the slice-3a PR body): `mode`
// keeps its item name verbatim (no rename — vocabulary stability where
// semantics are load-bearing), and `definitionOfDone` rides under its
// own name for the same reason. The item/event path imposes no length
// cap on definitionOfDone, so the board carries the string whole —
// presence over truncation.
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
  const dir = mkdtempSync(join(tmpdir(), "workitems-brief-"));
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

test("slice3a fate re-pin (§4.1): a sentinel definitionOfDone is PRESENT on the board row, for read and write items alike", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose-r", "work.proposed", {
    workItemId: "brief-read", title: "Read brief", definitionOfDone: "DOD-SENTINEL-BRIEF",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.workerKey, "accept-r", "work.accepted", "brief-read");
  let row = f.board("brief-read");
  assert.equal(row.definitionOfDone, "DOD-SENTINEL-BRIEF");
  assert.ok(JSON.stringify(row).includes("DOD-SENTINEL-BRIEF"), "the brief reaches the board row (step 0 measured its absence)");
  assert.equal(row.mode, "read");

  f.send(f.ownerKey, "propose-w", "work.proposed", {
    workItemId: "brief-write", title: "Write brief", definitionOfDone: "DOD-WRITE-SENTINEL",
    accountableMemberId: "worker", mode: "write",
  });
  f.mutate(f.workerKey, "accept-w", "work.accepted", "brief-write");
  row = f.board("brief-write");
  assert.equal(row.definitionOfDone, "DOD-WRITE-SENTINEL");
  assert.equal(row.mode, "write");
});

test("slice3a: a long definitionOfDone is carried whole — no truncation (the item path caps it nowhere)", () => {
  const T0 = "2026-10-01T00:00:00.000Z";
  const long = `done means ${"x".repeat(5000)}`;
  const item = {
    id: "task-long", title: "Long brief", state: "accepted", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: long, labels: [], mode: "read", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, claim: null, supersededBy: null,
  };
  const row = boardClaimForWorkItem(item, null, { nowMs: Date.parse(T0) });
  assert.equal(row.definitionOfDone, long);
  assert.equal(row.definitionOfDone.length, long.length);
});

test("slice3a registry round-trip: definitionOfDone + mode survive the real SQLite codec; workOf validates them", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "brief-rt", title: "Round trip", definitionOfDone: "RT-DOD-SENTINEL",
    accountableMemberId: "worker", mode: "write",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "brief-rt");
  const row = f.board("brief-rt");
  assert.equal(row.definitionOfDone, "RT-DOD-SENTINEL");
  assert.equal(row.mode, "write");
  const validated = workOf(row);
  assert.equal(validated.definitionOfDone, "RT-DOD-SENTINEL");
  assert.equal(validated.mode, "write");
  const legacy = workOf({ id: "legacy-1", title: "Legacy" });
  assert.equal(legacy.definitionOfDone, null);
  assert.equal(legacy.mode, null);
  assert.throws(() => workOf({ id: "bad-1", mode: "execute" }), /mode must be one of read, write/);
  assert.throws(() => workOf({ id: "bad-2", definitionOfDone: 42 }), /definitionOfDone must be a string or null/);
});

test("slice3a phantom: a successor phantom card carries brief defaults (definitionOfDone null, mode null)", () => {
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
  assert.equal(phantom.definitionOfDone, null);
  assert.equal(phantom.mode, null);
});
