// HUNT-LOSS (2026-10-18): the board history cap (MAX_CLAIM_HISTORY = 200)
// dropped stamps oldest-first, including divergence-repair stamps — the
// one class of board history no journal event re-derives (the mapping's
// preservation loop exists precisely to carry them across re-mapping).
// Once an item passed 200 event-derived stamps, a repair stamp older than
// the window was sliced off and folded silently into historyOmitted, and
// every later sync sourced preservation from the already-lossy row, so
// the repair record was gone for good. The cap now drops event-derived
// stamps only; repair stamps are exempt. Pure-mapping tests (no store).
import test from "node:test";
import assert from "node:assert/strict";
import {
  boardClaimForWorkItem, planWorkItemBoardBackfill, DIVERGENCE_REPAIR_NOTE,
} from "../server/work-item-board.mjs";

const T0 = "2026-10-01T00:00:00.000Z";
const H = 3600e3;
const at = ms => new Date(Date.parse(T0) + ms).toISOString();
const NOW = Date.parse(T0) + 10 * H;
let eventSeq = 0;
const ev = (type, atMs, actorId, data) => ({ id: `ev-${++eventSeq}`, type, actorId, at: at(atMs), data });
const factsFor = events => {
  const byEventId = new Map(events.map(event => [event.id, event]));
  return { events, byEventId, pullRequests: [], blocks: [], supersedeEvents: events.filter(e => e.type === "work.superseded") };
};
function item(overrides = {}) {
  return {
    id: "task-a", title: "Task A", state: "accepted", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: "done means done", labels: [], mode: "read", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, claim: null, supersededBy: null,
    ...overrides,
  };
}
const renewalStorm = count => {
  const events = [ev("work.proposed", 0, "owner", { workItemId: "task-a" })];
  for (let i = 1; i <= count; i += 1) events.push(ev("claim.renewed", i * 60e3, "worker", { workItemId: "task-a" }));
  return events;
};
const repairStamp = atMs => ({ at: at(atMs), agentId: "system", action: "state:unclaimed", note: DIVERGENCE_REPAIR_NOTE });
const isRepair = stamp => typeof stamp?.note === "string" && stamp.note.startsWith("divergence repair:");

test("history cap drops event stamps, never a divergence-repair stamp", () => {
  const events = renewalStorm(210); // 211 derived stamps
  const existing = { history: [repairStamp(-24 * H)] }; // repair predates every event
  const row = boardClaimForWorkItem(item(), factsFor(events), { nowMs: NOW, existing });
  assert.equal(row.history.length, 200);
  assert.ok(row.history.some(isRepair), "the board-native repair record must survive the cap");
  // 11 derived stamps fell out of the derivation window, plus 1 more event
  // stamp dropped to make room for the exempt repair stamp: 12, all counted.
  assert.equal(row.historyOmitted, 12);
});

test("history cap is unchanged when no repair stamps exist", () => {
  const events = renewalStorm(210);
  const row = boardClaimForWorkItem(item(), factsFor(events), { nowMs: NOW });
  assert.equal(row.history.length, 200);
  assert.equal(row.historyOmitted, 11);
  assert.ok(!row.history.some(isRepair));
});

test("history under the cap is untouched", () => {
  const events = renewalStorm(4);
  const existing = { history: [repairStamp(-24 * H)] };
  const row = boardClaimForWorkItem(item(), factsFor(events), { nowMs: NOW, existing });
  assert.equal(row.history.length, 6); // 5 derived + 1 preserved repair stamp
  assert.equal(row.historyOmitted ?? 0, 0);
  assert.ok(row.history.some(isRepair));
});

test("a rework repair at the cap keeps the earlier repair stamp", () => {
  // Proof-of-completion events + a renewal storm sized so the mapped
  // history sits exactly at the cap (1 proposed + 197 renewed + completed
  // + blocked = 200 stamps).
  const events = [ev("work.proposed", 0, "owner", { workItemId: "task-a" })];
  for (let i = 1; i <= 197; i += 1) events.push(ev("claim.renewed", i * 60e3, "worker", { workItemId: "task-a" }));
  events.push(ev("work.completed", 6 * H, "worker", { workItemId: "task-a" }));
  events.push(ev("work.blocked", 7 * H, "worker", { workItemId: "task-a", reason: "rework" }));
  const blocked = item({
    state: "blocked",
    claim: { holderId: "worker", repository: "Uuriko/project-room", ref: "main", paths: ["server/**"], status: "active", acquiredAt: at(2 * H), expiresAt: at(30 * H) },
    blocker: { reason: "rework", nextAction: "redo", eventId: "ev-block" },
    receipt: { producerId: "worker", summary: "done v1", eventId: "ev-complete" },
    updatedAt: at(7 * H),
  });
  const base = boardClaimForWorkItem(blocked, factsFor(events), { nowMs: NOW });
  assert.equal(base.history.length, 200);
  // The live board row says done (diverged, rework class) and already
  // carries one repair stamp from an earlier repair, older than the window.
  const current = { ...base, state: "done", owner: "worker", history: [repairStamp(-24 * H), ...base.history] };
  const plan = planWorkItemBoardBackfill({ items: [blocked], events, existing: new Map([["task-a", current]]), nowMs: NOW });
  assert.equal(plan.diverged.length, 1);
  assert.equal(plan.diverged[0].class, "rework");
  const repaired = plan.rows.get("task-a");
  assert.ok(repaired, "rework rows enter the write plan as repairs");
  const repairs = repaired.history.filter(stamp => stamp.note === DIVERGENCE_REPAIR_NOTE);
  assert.equal(repairs.length, 2, "the earlier repair stamp and the new one both survive");
  assert.equal(repaired.history.length, 200);
});
