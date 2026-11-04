// Assignment deadline ladder (server/assignment-deadlines.mjs).
// Contract: a silent delegate is re-pinged, then the assigner (or owner) is
// told, then the task is announced free; lease holders are warned before
// expiry; expiry itself stays with #5841/#5843; each rung fires once.
import test from "node:test";
import assert from "node:assert/strict";
import { assignmentStage, claimConflictResult, deadlineNoticeKey, dueDeadlineNotices, leaseStage } from "../server/assignment-deadlines.mjs";

const T0 = Date.parse("2026-11-03T00:00:00Z");
const MIN = 60_000;
const item = (extra = {}) => ({ id: "w1", revision: 3, state: "proposed", accountableMemberId: "del", proposedById: "asg", createdAt: new Date(T0).toISOString(), ...extra });

test("ladder: waiting -> reping -> escalate -> free", () => {
  assert.equal(assignmentStage(item(), T0 + 5 * MIN).stage, "waiting");
  const re = assignmentStage(item(), T0 + 10 * MIN);
  assert.equal(re.stage, "reping"); assert.deepEqual(re.notify, ["del"]);
  const esc = assignmentStage(item(), T0 + 30 * MIN);
  assert.equal(esc.stage, "escalate"); assert.deepEqual(esc.notify, ["asg"]);
  const free = assignmentStage(item(), T0 + 4 * 60 * MIN);
  assert.equal(free.stage, "free"); assert.deepEqual(free.notify, ["asg", "del"]);
});

test("escalation goes to the owner when there is no separate assigner", () => {
  assert.deepEqual(assignmentStage(item({ proposedById: "del" }), T0 + 31 * MIN, { ownerId: "own" }).notify, ["own"]);
  assert.deepEqual(assignmentStage(item({ proposedById: null }), T0 + 31 * MIN, { ownerId: "own" }).notify, ["own"]);
  assert.deepEqual(assignmentStage(item({ proposedById: null }), T0 + 31 * MIN, { ownerId: "del" }).notify, []);
});

test("non-proposed, superseded, unassigned or undated items are ignored", () => {
  for (const extra of [{ state: "accepted" }, { supersededBy: "w2" }, { accountableMemberId: null }, { createdAt: "nope" }])
    assert.equal(assignmentStage(item(extra), T0 + 60 * MIN), null);
});

test("lease: live, warn before expiry, expired handed to lease-expiry notice", () => {
  const work = { id: "w1", state: "claimed", claim: { holderId: "h", leaseExpiresAt: new Date(T0 + 60 * MIN).toISOString() } };
  assert.equal(leaseStage(work, T0).stage, "live");
  const warn = leaseStage(work, T0 + 50 * MIN); assert.equal(warn.stage, "warn"); assert.deepEqual(warn.notify, ["h"]);
  const gone = leaseStage(work, T0 + 61 * MIN); assert.equal(gone.stage, "expired"); assert.deepEqual(gone.notify, []); assert.match(gone.handledBy, /5841/);
});

test("second claimer gets a normal already_claimed result; none after expiry", () => {
  const work = { id: "w1", claim: { holderId: "h", leaseExpiresAt: new Date(T0 + 60 * MIN).toISOString() } };
  const r = claimConflictResult(work, T0);
  assert.equal(r.result, "already_claimed"); assert.equal(r.holderId, "h"); assert.equal(r.ok, false);
  assert.equal(claimConflictResult(work, T0 + 61 * MIN), null);
});

test("each rung fires once per revision", () => {
  const sent = new Set();
  const first = dueDeadlineNotices([item()], T0 + 11 * MIN, { sent });
  assert.equal(first.length, 1); first.forEach(n => sent.add(n.key));
  assert.equal(dueDeadlineNotices([item()], T0 + 12 * MIN, { sent }).length, 0);
  assert.equal(dueDeadlineNotices([item({ revision: 4 })], T0 + 12 * MIN, { sent }).length, 1, "new revision resets");
  assert.equal(deadlineNoticeKey(assignmentStage(item(), T0)), null, "waiting has no notice");
  const leaseItem = { id: "w9", state: "claimed", claim: { holderId: "h", leaseExpiresAt: new Date(T0 + 10 * MIN).toISOString() } };
  const lw = dueDeadlineNotices([leaseItem], T0, { sent });
  assert.equal(lw.length, 1); assert.equal(lw[0].stage, "warn");
});

test("runner is off by default and posts each rung once when on", async () => {
  const { runAssignmentDeadlines, assignmentDeadlinesEnabled } = await import("../server/assignment-deadlines.mjs");
  assert.equal(assignmentDeadlinesEnabled({}, "r"), false);
  assert.equal(assignmentDeadlinesEnabled({ ROOM_ASSIGNMENT_DEADLINES: "a,r" }, "r"), true);
  const events = [];
  const state = { room: { ownerId: "own" }, members: { own: { id: "own" }, del: { id: "del", kind: "human" }, asg: { id: "asg" } },
    workItems: { w1: { ...item(), title: "Fix it" } } };
  const store = { featureEnv: {}, room: () => ({ state }), workClaims: { list: () => [] } };
  assert.deepEqual(runAssignmentDeadlines(store, "r", T0 + 11 * MIN), []);
  store.featureEnv = { ROOM_ASSIGNMENT_DEADLINES: "on" };
  const seen = new Set();
  const append = (_s, _r, { id }) => (seen.has(id) ? null : (seen.add(id), { sequence: seen.size }));
  const ids = runAssignmentDeadlines(store, "r", T0 + 11 * MIN, { append });
  assert.equal(ids.length, 1); events.push(...ids);
  assert.deepEqual(runAssignmentDeadlines(store, "r", T0 + 11 * MIN, { append }), [], "a rung already posted is not posted or woken again");
});
