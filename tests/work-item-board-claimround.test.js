// B4-HARDENING (shard diagnosis): PR-A added claimRound to the claim
// codec, so every stored board row decodes carrying it — but the
// work-item mapper never carried it, so a mapped row never equalled its
// stored form and the board diff could not converge (hosted failures:
// sync lifecycle, §4.6 end-to-end, store backfill). The mapper follows
// the #3547/#3684 rule for kernel fields the work item cannot express:
// preserve the existing row's value, normalised exactly as workOf does.
import test from "node:test";
import assert from "node:assert/strict";
import { boardClaimForWorkItem, sameClaimRow } from "../server/work-item-board.mjs";

const T0 = "2026-10-01T00:00:00.000Z";
const H = 3600e3;
const at = ms => new Date(Date.parse(T0) + ms).toISOString();
const NOW = Date.parse(T0) + 10 * H;
let eventSeq = 0;
const ev = (type, atMs, actorId, data) => ({ id: `ev-${++eventSeq}`, type, actorId, at: at(atMs), data });
const events = [
  ev("work.proposed", 0, "owner", { workItemId: "task-a" }),
  ev("work.completed", 6 * H, "worker", { workItemId: "task-a" }),
  ev("work.blocked", 7 * H, "worker", { workItemId: "task-a", reason: "rework" }),
];
const facts = { events, byEventId: new Map(events.map(event => [event.id, event])),
  pullRequests: [], blocks: [], supersedeEvents: events.filter(e => e.type === "work.superseded") };
const item = { id: "task-a", title: "Task A", state: "working", proposedById: "owner",
  accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
  ownerDecisionRequired: false, independentVerificationRequired: false,
  definitionOfDone: "done means done", labels: [], mode: "read", sourceMessageId: null,
  createdAt: T0, updatedAt: at(7 * H), revision: 1,
  receipt: { producerId: "worker", summary: "done v1", eventId: "ev-complete" },
  receiptHistory: [], verification: null, verificationHistory: [],
  decision: null, decisionHistory: [], blocker: null,
  claim: { holderId: "worker", repository: "Uuriko/project-room", ref: "main",
    paths: ["server/**"], status: "active", acquiredAt: at(2 * H), expiresAt: at(30 * H) },
  supersededBy: null };

test("mapper: a fresh mapped row carries claimRound 0 — the codec default it will be stored with", () => {
  const row = boardClaimForWorkItem(item, facts, { nowMs: NOW });
  assert.ok(row, "the claimed item maps to a board row");
  assert.equal(row.claimRound, 0);
});

test("mapper: an existing row's claimRound is preserved verbatim, so the diff converges", () => {
  const first = boardClaimForWorkItem(item, facts, { nowMs: NOW });
  const stored = { ...first, claimRound: 2 };
  const remapped = boardClaimForWorkItem(item, facts, { nowMs: NOW, existing: stored });
  assert.equal(remapped.claimRound, 2, "the round counter survives re-mapping");
  assert.equal(sameClaimRow(remapped, stored), true,
    "re-mapping a live row is a byte-stable no-op — the unchanged check converges");
});
