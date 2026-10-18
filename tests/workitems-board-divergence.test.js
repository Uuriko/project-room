// B-4' Phase 0 slice 1 (#3607, Appendix D §D.2): diverged rows are
// classified (rework vs board_native); only rework rows get the
// transition-lite repair, in backfill and sync alike; every computed
// divergence lands in the per-room snapshot (healthy value: zero).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  boardClaimForWorkItem, planWorkItemBoardBackfill, workItemBoardDivergence,
  DIVERGENCE_REPAIR_NOTE,
} from "../server/work-item-board.mjs";
import { handleLegalRequest } from "../server/legal-routes.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const T0 = "2026-10-01T00:00:00.000Z";
const H = 3600e3;
const at = ms => new Date(Date.parse(T0) + ms).toISOString();
const NOW = Date.parse(T0) + 10 * H;
let eventSeq = 0;
const ev = (type, atMs, actorId, data) => ({ id: `ev-${++eventSeq}`, type, actorId, at: at(atMs), data });
function item(overrides = {}) {
  return {
    id: "task-a", title: "Task A", state: "proposed", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: "done means done", labels: [], mode: "read", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, claim: null, supersededBy: null,
    ...overrides,
  };
}
const liveClaimFields = (overrides = {}) => ({
  holderId: "worker", repository: "Uuriko/project-room", ref: "main",
  paths: ["server/**"], status: "active", acquiredAt: at(2 * H), expiresAt: at(30 * H),
  ...overrides,
});
const factsFor = events => {
  const byEventId = new Map(events.map(event => [event.id, event]));
  return { events, byEventId, pullRequests: [], blocks: [], supersedeEvents: events.filter(e => e.type === "work.superseded") };
};
// An item that provably completed before: completion event + receipt.
const proofEvents = () => [
  ev("work.proposed", 0, "owner", { workItemId: "task-a" }),
  ev("work.completed", 6 * H, "worker", { workItemId: "task-a" }),
  ev("work.blocked", 7 * H, "worker", { workItemId: "task-a", reason: "rework" }),
];
const proofReceipt = { producerId: "worker", summary: "done v1", eventId: "ev-complete" };
function itemForState(state) {
  const base = { receipt: proofReceipt, updatedAt: at(7 * H) };
  switch (state) {
    case "accepted": return item({ ...base, state });
    case "working": return item({ ...base, state, claim: liveClaimFields() });
    case "blocked": return item({ ...base, state, claim: liveClaimFields(), blocker: { reason: "rework", nextAction: "redo", eventId: "ev-block" } });
    case "completed": return item({ ...base, state, claim: liveClaimFields() });
    case "superseded": return item({ ...base, state, claim: liveClaimFields({ status: "superseded" }) });
    default: throw new Error(state);
  }
}

test("divergence table: every reachable (itemState x boardState) pair, with proof of completion", () => {
  // [diverged, class] per board state; null class = not diverged.
  // Active board rows here are held by a foreign owner ("mallory").
  const ACTIVE = ["claimed", "in_progress", "blocked"];
  const expected = {
    accepted: { unclaimed: [false, null], done: [true, "rework"], closed: [true, "board_native"] },
    working: { unclaimed: [false, null], done: [true, "rework"], closed: [true, "board_native"] },
    blocked: { unclaimed: [false, null], done: [true, "rework"], closed: [true, "board_native"] },
    completed: { unclaimed: [false, null], done: [false, null], closed: [true, "board_native"] },
    superseded: { unclaimed: [false, null], done: [true, "board_native"], closed: [false, null] },
  };
  for (const itemState of Object.keys(expected)) {
    for (const boardState of [...ACTIVE, "unclaimed", "done", "closed"]) {
      const events = proofEvents();
      const it = itemForState(itemState);
      const base = boardClaimForWorkItem(it, factsFor(events), { nowMs: NOW });
      const owner = boardState === "unclaimed" ? null : ACTIVE.includes(boardState) ? "mallory" : "worker";
      const existing = new Map([["task-a", { ...base, state: boardState, owner }]]);
      const plan = planWorkItemBoardBackfill({ items: [it], events, existing, nowMs: NOW });
      const [wantDiverged, wantClass] = ACTIVE.includes(boardState) ? [true, "board_native"] : expected[itemState][boardState];
      const label = `${itemState} x ${boardState}`;
      assert.equal(plan.diverged.length, wantDiverged ? 1 : 0, label);
      if (wantDiverged) assert.equal(plan.diverged[0].class, wantClass, label);
      // Rework rows enter the write plan as repairs; board_native rows
      // stay excluded; non-diverged rows are planned as usual.
      assert.equal(plan.rows.has("task-a"), wantClass === "rework" || !wantDiverged, label);
      if (wantClass === "rework") {
        const repaired = plan.rows.get("task-a");
        const doneAt = repaired.history.findIndex(s => s.action === "state:done");
        const repairAt = repaired.history.findIndex(s => s.note === DIVERGENCE_REPAIR_NOTE);
        assert.ok(doneAt !== -1 && repairAt > doneAt, label);
        assert.equal(repaired.history[repairAt].action, `state:${repaired.state}`, label);
      }
    }
    // Active board rows held by a principal the item names never diverge.
    for (const boardState of ACTIVE) {
      const events = proofEvents();
      const it = itemForState(itemState);
      const base = boardClaimForWorkItem(it, factsFor(events), { nowMs: NOW });
      const existing = new Map([["task-a", { ...base, state: boardState, owner: "worker" }]]);
      const plan = planWorkItemBoardBackfill({ items: [it], events, existing, nowMs: NOW });
      assert.equal(plan.diverged.length, 0, `${itemState} x ${boardState} (principal owner)`);
    }
  }
});

test("classification proof rules: no completion proof is board_native; a receipt alone proves rework", () => {
  const blocked = itemForState("blocked");
  const base = boardClaimForWorkItem(blocked, factsFor([]), { nowMs: NOW });
  const doneRow = new Map([["task-a", { ...base, state: "done", owner: "worker" }]]);
  // No completion event and the receipt stripped: unprovable.
  const unproven = planWorkItemBoardBackfill({ items: [{ ...blocked, receipt: null }], events: [], existing: doneRow, nowMs: NOW });
  assert.deepEqual(unproven.diverged.map(e => e.class), ["board_native"]);
  assert.equal(unproven.rows.has("task-a"), false);
  // Receipt present, no events at all: provable.
  const byReceipt = planWorkItemBoardBackfill({ items: [blocked], events: [], existing: doneRow, nowMs: NOW });
  assert.deepEqual(byReceipt.diverged.map(e => e.class), ["rework"]);
  assert.equal(byReceipt.rows.get("task-a").state, "blocked");
});

// ---------------------------------------------------------------------------
// Store-level: real RoomStore, the §4.6 scenario end to end.

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workitems-divergence-"));
  const filename = join(dir, "room.sqlite");
  const store = new RoomStore(filename, { workItemBoardBackfill: "manual" });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] },
  });
  const workerKey = store.issueAccessKey("commons", "worker");
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const getItem = id => store.room("commons").state.workItems[id];
  const mutate = (key, id, type, workItemId, data = {}) =>
    send(key, id, type, { workItemId, expectedRevision: getItem(workItemId).revision, ...data });
  return { store, ownerKey, workerKey, send, item: getItem, mutate };
}

function driveToCompleted(f, id) {
  const signEvidence = makeTestSigner(f.store);
  f.send(f.ownerKey, `propose-${id}`, "work.proposed", {
    workItemId: id, title: "Reworkable", definitionOfDone: "ship it",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.workerKey, `accept-${id}`, "work.accepted", id);
  f.mutate(f.workerKey, `start-${id}`, "work.started", id);
  f.mutate(f.workerKey, `complete-${id}`, "work.completed", id, {
    summary: "done v1", producerId: "worker", nextAction: "verify",
    evidenceUrl: "https://example.com/v1", signedEvidence: signEvidence(),
  });
}

test("sync: §4.6 end-to-end — completed then work.blocked reopens the board row, stamps after done, snapshot counts then clears", (t) => {
  const f = fixture(t);
  driveToCompleted(f, "task-rework");
  assert.equal(f.store.workClaims.get("commons", "task-rework").state, "done");
  f.mutate(f.workerKey, "rework", "work.blocked", "task-rework", { reason: "rework needed", nextAction: "redo" });
  assert.equal(f.item("task-rework").state, "blocked");
  const row = f.store.workClaims.get("commons", "task-rework");
  assert.equal(row.state, "blocked"); // was: done forever (the silent skip)
  assert.equal(row.premiseFlag.reason, "rework needed");
  const doneAt = row.history.findIndex(s => s.action === "state:done");
  assert.ok(doneAt !== -1); // the done stamp stays (append-only record)
  const afterDone = row.history.slice(doneAt + 1);
  assert.ok(afterDone.some(s => s.action === "state:blocked" && s.note === "rework needed"));
  const repair = afterDone.find(s => s.note === DIVERGENCE_REPAIR_NOTE);
  assert.ok(repair, JSON.stringify(row.history));
  assert.equal(repair.action, "state:blocked");
  // The sync that repaired it surfaced the count it computed.
  const snap = workItemBoardDivergence(f.store, "commons");
  assert.deepEqual([snap.roomId, snap.diverged, snap.rework, snap.boardNative], ["commons", 1, 1, 0]);
  // Idempotent: a backfill re-run changes nothing, adds no stamps, and
  // the fresh (clean) computation clears the snapshot to healthy zero.
  const historyBefore = JSON.stringify(row.history);
  const report = f.store.backfillRoomWorkItemClaims("commons");
  assert.deepEqual(report.diverged, []);
  assert.equal(report.updated, 0);
  assert.equal(JSON.stringify(f.store.workClaims.get("commons", "task-rework").history), historyBefore);
  assert.equal(workItemBoardDivergence(f.store, "commons").diverged, 0);
  assert.equal(workItemBoardDivergence(f.store).divergedRows, 0);
});

test("backfill: a pre-diverged rework fixture is repaired with no room events; a foreign-owner row is untouched and counted board_native", async (t) => {
  const f = fixture(t);
  driveToCompleted(f, "task-legacy");
  f.mutate(f.workerKey, "rework", "work.blocked", "task-legacy", { reason: "rework needed", nextAction: "redo" });
  f.send(f.ownerKey, "propose-foreign", "work.proposed", {
    workItemId: "task-foreign", title: "Foreign held", definitionOfDone: "x",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.workerKey, "accept-foreign", "work.accepted", "task-foreign");
  // Stage both diverged shapes AFTER all commands (any later sync would
  // repair the rework row itself): legacy row back at done with the
  // repair/blocked stamps stripped; foreign row held by "mallory".
  const repaired = f.store.workClaims.get("commons", "task-legacy");
  f.store.workClaims.set("commons", {
    ...repaired, state: "done", premiseFlag: null,
    history: repaired.history.filter(s => s.note !== DIVERGENCE_REPAIR_NOTE && s.action !== "state:blocked"),
  });
  const foreignRow = f.store.workClaims.get("commons", "task-foreign");
  f.store.workClaims.set("commons", { ...foreignRow, state: "claimed", owner: "mallory" });

  const claimEvents = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id='commons' AND body LIKE '%work_claim.updated%'").get().n;
  const eventsBefore = claimEvents();
  const report = f.store.backfillRoomWorkItemClaims("commons");
  assert.deepEqual(report.diverged.map(e => [e.workItemId, e.class]).sort(),
    [["task-foreign", "board_native"], ["task-legacy", "rework"]].sort());
  const row = f.store.workClaims.get("commons", "task-legacy");
  assert.equal(row.state, "blocked");
  assert.equal(row.premiseFlag.reason, "rework needed");
  const doneAt = row.history.findIndex(s => s.action === "state:done");
  assert.ok(row.history.slice(doneAt + 1).some(s => s.note === DIVERGENCE_REPAIR_NOTE));
  assert.equal(claimEvents(), eventsBefore); // backfill emits NO room events
  const foreignAfter = f.store.workClaims.get("commons", "task-foreign");
  assert.equal(foreignAfter.state, "claimed");
  assert.equal(foreignAfter.owner, "mallory"); // untouched, exactly as before
  const snapshot = workItemBoardDivergence(f.store, "commons");
  assert.deepEqual([snapshot.diverged, snapshot.rework, snapshot.boardNative], [2, 1, 1]);
  const aggregate = workItemBoardDivergence(f.store);
  assert.deepEqual([aggregate.divergedRooms, aggregate.divergedRows], [1, 2]);

  // The health surface carries the same aggregate.
  let health = null;
  const handled = await handleLegalRequest({
    req: { method: "GET" }, res: {}, url: new URL("http://x/api/health/jobs"), store: f.store,
    json: (res, status, value) => { health = value; }, reject: (status, code, message) => { throw new Error(message); },
  });
  assert.equal(handled, true);
  assert.deepEqual(health.workItemBoard, { divergedRooms: 1, divergedRows: 2 });

  // The foreign row also keeps the sync skip exactly: a live command on
  // its item moves the item, never the board row.
  f.mutate(f.workerKey, "start-foreign", "work.started", "task-foreign");
  assert.equal(f.item("task-foreign").state, "working");
  const foreignFinal = f.store.workClaims.get("commons", "task-foreign");
  assert.equal(foreignFinal.state, "claimed");
  assert.equal(foreignFinal.owner, "mallory");
});

test("B3 (#3613): board re-mapping preserves a review's per-criterion outcomes", () => {
  const it = item({ state: "working", claim: liveClaimFields() });
  const outcomes = [{ criterion: "docs updated", verdict: "pass" }, { criterion: "tests green", verdict: "fail" }];
  const existing = { reviews: [{ memberId: "sage", verdict: "approve", summary: "ok", url: null, at: at(3 * H), criteriaOutcomes: outcomes }] };
  const row = boardClaimForWorkItem(it, factsFor([]), { nowMs: NOW, existing });
  assert.deepEqual(row.reviews.at(-1).criteriaOutcomes, outcomes);
  // A review without outcomes re-maps exactly as before.
  const plain = boardClaimForWorkItem(it, factsFor([]), { nowMs: NOW,
    existing: { reviews: [{ memberId: "sage", verdict: "approve", summary: "ok", url: null, at: at(3 * H) }] } });
  assert.deepEqual(plain.reviews.at(-1), { memberId: "sage", verdict: "approve", summary: "ok", url: null, at: at(3 * H) });
});
