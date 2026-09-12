import test from "node:test";
import assert from "node:assert/strict";
import { projectBoard, BOARD_COLUMNS } from "../src/board.js";

const members = {
  owner: { id: "owner", kind: "human", permissions: ["steer", "decide"], active: true },
  agent: { id: "agent", kind: "agent", permissions: ["accept_work", "complete_work"], active: true }
};
const base = { mode: "read", claim: null, receipt: null, verification: null, decision: null, blocker: null,
  supersededBy: null, accountableMemberId: "agent", revision: 1, independentVerificationRequired: false,
  ownerDecisionRequired: false, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" };
const items = {
  p1: { ...base, id: "p1", title: "Proposed", state: "proposed", revision: 0 },
  a1: { ...base, id: "a1", title: "Accepted", state: "accepted" },
  w1: { ...base, id: "w1", title: "Working", state: "working" },
  b1: { ...base, id: "b1", title: "Blocked", state: "blocked", blocker: { reason: "Waiting", nextAction: "Ping Sam", eventId: "e3" } },
  c1: { ...base, id: "c1", title: "Done", state: "completed", receipt: { eventId: "e5", evidenceVersion: "v1", reportedById: "agent", producerId: null, summary: "Done", nextAction: "None", checksClaimed: [] } },
  c2: { ...base, id: "c2", title: "Review", state: "completed", independentVerificationRequired: true, verifierMemberId: "owner",
    receipt: { eventId: "e6", evidenceVersion: "v2", reportedById: "agent", producerId: "agent", summary: "Done", nextAction: "Review", checksClaimed: [] } },
  s1: { ...base, id: "s1", title: "Replaced", state: "superseded", supersededBy: "p1" },
  h1: { ...base, id: "h1", title: "Handed off", state: "working",
    handoff: { open: true, eventId: "e8", at: "2026-09-11T01:00:00.000Z", actorId: "agent", doneSummary: "3 of 5 feeds parsed",
      evidenceUrl: null, evidenceVersion: null, nextAction: "Reassign adapter work", limitReason: "context window exhausted", haltAll: false } }
};
const state = { room: { id: "commons" }, members, workItems: items, messages: [],
  agentHalts: { agent: { eventId: "e8", at: "2026-09-11T01:00:00.000Z", reason: "context window exhausted", workItemId: "h1" } } };

test("board projects every work item into exactly one column with handoff and halt surfaced", () => {
  const board = projectBoard(state, Date.parse("2026-09-11T02:00:00.000Z"));
  assert.equal(board.contractVersion, 1);
  for (const column of BOARD_COLUMNS) assert.ok(Array.isArray(board.columns[column]), column);
  const placed = Object.values(board.columns).flat().map(card => card.id).sort();
  assert.deepEqual(placed, Object.keys(items).sort());
  assert.deepEqual(board.columns.handoff.map(c => c.id), ["h1"]);
  assert.deepEqual(board.columns.proposed.map(c => c.id), ["p1"]);
  assert.deepEqual(board.columns.accepted.map(c => c.id), ["a1"]);
  assert.deepEqual(board.columns.working.map(c => c.id), ["w1"]);
  assert.deepEqual(board.columns.blocked.map(c => c.id), ["b1"]);
  assert.deepEqual(board.columns.done.map(c => c.id), ["c1"]);
  assert.deepEqual(board.columns.review.map(c => c.id), ["c2"]);
  assert.deepEqual(board.columns.superseded.map(c => c.id), ["s1"]);
  const card = board.columns.handoff[0];
  assert.equal(card.handoff.limitReason, "context window exhausted");
  assert.equal(card.handoff.doneSummary, "3 of 5 feeds parsed");
  assert.equal(card.handoff.nextAction, "Reassign adapter work");
  assert.equal(card.state, "working", "handoff does not close or re-state the item");
  assert.equal(card.next.action, "triaged_handoff");
  assert.equal(board.counts.handoff, 1);
  assert.equal(board.counts.total, 8);
  assert.deepEqual(board.halts, [{ memberId: "agent", eventId: "e8", at: "2026-09-11T01:00:00.000Z",
    reason: "context window exhausted", workItemId: "h1" }]);
  const clean = projectBoard({ ...state, agentHalts: {}, workItems: { w1: items.w1 } });
  assert.deepEqual(clean.halts, []);
  assert.equal(clean.columns.handoff.length, 0);
});
