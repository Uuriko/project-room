import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T, WORK_STATES, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const ROOM = "room-project-room-v0";
const rng = seed => () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
const choose = (random, values) => values[Math.floor(random() * values.length)];

function assertInvariants(state, id, revision, history) {
  const item = state.workItems[id];
  assert.equal(item.revision, revision, "revision counts accepted work mutations");
  assert.equal(Boolean(item.blocker), item.state === WORK_STATES.BLOCKED, "only blocked work has a current blocker");
  assert.equal(new Set(item.receiptHistory.map(row => row.eventId)).size, item.receiptHistory.length, "completion history is unique");
  if (item.verification) {
    assert.equal(item.verification.completionEventId, item.receipt.eventId);
    assert.equal(item.verification.evidenceVersion, item.receipt.evidenceVersion);
    assert.equal(item.verification.verifierId, item.verifierMemberId);
  }
  if (item.decision) {
    assert.equal(item.decision.completionEventId, item.receipt.eventId);
    assert.equal(item.decision.evidenceVersion, item.receipt.evidenceVersion);
    if (item.decision.decision === "approved") {
      assert.equal(item.verification?.result, "pass");
      assert.equal(item.verification?.independenceConfirmed, true);
    }
  }
  assert.deepEqual(replay(history), state, "incremental projection equals full replay after every accepted event");
}

for (let seed = 1; seed <= 16; seed++) test(`seeded work lifecycle preserves replay and approval invariants: ${seed}`, () => {
  const random = rng(seed), id = `random-work-${seed}`;
  const history = structuredClone(seedEvents);
  let state = replay(history), serial = 0, revision = 0;
  const send = (actorId, type, data) => {
    const incoming = { id: `${id}-event-${++serial}`, idempotencyKey: `${id}-key-${serial}`, roomId: ROOM, actorId, type,
      at: new Date(Date.UTC(2026, 8, 10, 12, 0, serial)).toISOString(), causationId: null, data };
    const before = structuredClone(state);
    state = applyEvent(state, incoming); history.push(incoming);
    if (type !== T.WORK_PROPOSED && type !== T.MESSAGE_POSTED && type !== T.MESSAGE_REACTION_SET) revision++;
    assert.deepEqual(applyEvent(state, incoming), state, "exact retry is idempotent");
    assert.deepEqual(before.eventLog, history.slice(0, -1), "the prior projection remains immutable");
    assertInvariants(state, id, revision, history);
  };
  const mutate = (actorId, type, data = {}) => send(actorId, type, { workItemId: id, expectedRevision: revision, ...data });
  send("potter", T.WORK_PROPOSED, { workItemId: id, title: `Random lifecycle ${seed}`, definitionOfDone: "Exact evidence survives replay",
    accountableMemberId: "codex", verifierMemberId: "instinct", independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "potter", mode: "read" });

  for (let step = 0; step < 64; step++) {
    const rejected = { id: `${id}-rejected-${step}`, idempotencyKey: `${id}-rejected-key-${step}`, roomId: ROOM, actorId: "codex",
      type: T.WORK_STARTED, at: new Date(Date.UTC(2026, 8, 10, 13, 0, step)).toISOString(), causationId: null,
      data: { workItemId: id, expectedRevision: revision + 1 } };
    const unchanged = structuredClone(state);
    assert.throws(() => applyEvent(state, rejected));
    assert.deepEqual(state, unchanged, "a rejected randomized transition cannot mutate projection or history");
    const item = state.workItems[id];
    if (item.state === WORK_STATES.PROPOSED) mutate("codex", T.WORK_ACCEPTED);
    else if (item.state === WORK_STATES.ACCEPTED) {
      const action = choose(random, ["start", "block", "complete"]);
      if (action === "start") mutate("codex", T.WORK_STARTED);
      else if (action === "block") mutate("codex", T.WORK_BLOCKED, { reason: "Need a source", nextAction: "Find the source" });
      else mutate("codex", T.WORK_COMPLETED, { summary: `Result ${serial}`, evidenceUrl: "https://example.invalid/result",
        evidenceVersion: `v-${serial}`, producerId: "codex", nextAction: "Review exact evidence" });
    } else if (item.state === WORK_STATES.WORKING) {
      if (random() < .3) mutate("codex", T.WORK_BLOCKED, { reason: "New fact", nextAction: "Update result" });
      else mutate("codex", T.WORK_COMPLETED, { summary: `Result ${serial}`, evidenceUrl: "https://example.invalid/result",
        evidenceVersion: `v-${serial}`, producerId: "codex", nextAction: "Review exact evidence" });
    } else if (item.state === WORK_STATES.BLOCKED) {
      mutate("codex", T.WORK_BLOCKER_RESOLVED, { resolution: "Source recovered" });
    } else {
      const exact = { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion };
      if (!item.verification || random() < .22) {
        const result = random() < .22 ? "fail" : "pass";
        mutate("instinct", T.VERIFICATION_RECORDED, { ...exact, result, summary: result === "pass" ? "Exact evidence passes" : "Evidence mismatch",
          ...(result === "fail" ? { nextAction: "Revise the evidence" } : {}) });
      } else if (!item.decision && item.verification.result === "pass" && item.verification.independenceConfirmed && random() < .65) {
        mutate("potter", T.OWNER_DECISION_RECORDED, { ...exact, decision: "approved", reason: "Accept exact result" });
      } else {
        mutate("codex", T.WORK_BLOCKED, { reason: "Rework requested", nextAction: "Prepare another version" });
      }
    }
  }
});
