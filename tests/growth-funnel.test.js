// G008: growth funnel. Pure funnel tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { funnelAnalysis, FunnelError } from "../server/growth-funnel.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof FunnelError && error.code === code);
const events = () => [
  { type: "member.invited", actorId: "a", at: "2026-09-10T10:00:00Z" },
  { type: "member.joined_via_invitation", actorId: "a", at: "2026-09-10T12:00:00Z" },
  { type: "work.claim", actorId: "a", at: "2026-09-11T10:00:00Z" },
  { type: "member.invited", actorId: "b", at: "2026-09-10T10:00:00Z" },
  { type: "member.joined_via_invitation", actorId: "b", at: "2026-09-10T11:00:00Z" },
  { type: "member.invited", actorId: "c", at: "2026-09-10T10:00:00Z" },
];

test("funnelAnalysis computes stages, rates, and medians", () => {
  const funnel = funnelAnalysis(events());
  assert.equal(funnel.invited, 3);
  assert.equal(funnel.joined, 2);
  assert.equal(funnel.firstWork, 1);
  assert.equal(funnel.inviteToJoinRate, 66.7);
  assert.equal(funnel.joinToWorkRate, 50);
  assert.equal(funnel.medianInviteToJoinMs, 5400000); // 1.5h median of 2h, 1h
  assert.equal(funnel.medianJoinToWorkMs, 79200000); // 22h
  assert.ok(Object.isFrozen(funnel) && Object.isFrozen(funnel.agents));
});
test("agents who join without an invite still count as joined", () => {
  const funnel = funnelAnalysis([{ type: "member.joined", actorId: "x", at: "2026-09-10T10:00:00Z" }]);
  assert.equal(funnel.invited, 0);
  assert.equal(funnel.joined, 1);
  assert.equal(funnel.inviteToJoinRate, null);
});
test("malformed inputs are refused", () => {
  throwsCode(() => funnelAnalysis("nope"), "invalid_funnel_input");
  throwsCode(() => funnelAnalysis([{ type: "x", actorId: "a", at: "bad" }]), "invalid_funnel_input");
});

test("funnelAnalysis tracks completion and second-contribution stages", () => {
  const funnel = funnelAnalysis([
    { type: "member.joined", actorId: "a", at: "2026-09-10T10:00:00Z" },
    { type: "work.claim", actorId: "a", at: "2026-09-11T10:00:00Z" },
    { type: "work.completed", actorId: "a", at: "2026-09-12T10:00:00Z" },
    { type: "work.claim", actorId: "a", at: "2026-09-13T10:00:00Z" },
    { type: "member.joined", actorId: "b", at: "2026-09-10T10:00:00Z" },
    { type: "work.claim", actorId: "b", at: "2026-09-11T10:00:00Z" },
    { type: "member.joined", actorId: "c", at: "2026-09-10T10:00:00Z" },
  ]);
  assert.equal(funnel.joined, 3);
  assert.equal(funnel.firstWork, 2);
  assert.equal(funnel.completed, 1);
  assert.equal(funnel.secondContribution, 1);
  assert.equal(funnel.workToCompletedRate, 50);
  assert.equal(funnel.completedToSecondRate, 100);
  assert.equal(funnel.medianWorkToCompletedMs, 24 * 3600 * 1000);
  assert.equal(funnel.medianCompletedToSecondMs, 24 * 3600 * 1000);
});

test("completion before first work is ignored; empty funnel stays null", () => {
  const funnel = funnelAnalysis([
    { type: "member.joined", actorId: "a", at: "2026-09-10T10:00:00Z" },
    { type: "work.completed", actorId: "a", at: "2026-09-09T10:00:00Z" },
  ]);
  assert.equal(funnel.firstWork, 0);
  assert.equal(funnel.completed, 0);
  assert.equal(funnel.secondContribution, 0);
  assert.equal(funnel.workToCompletedRate, null);
  assert.equal(funnel.medianWorkToCompletedMs, null);
});
