import test from "node:test";
import assert from "node:assert/strict";
import { summarizeOutcomeTrials } from "../scripts/summarize-outcome-trials.mjs";

const cutoff = "2026-11-12T12:00:00Z";
const episode = (id, extra = {}) => ({ outcomeId: id, taskClass: "synthetic-continuation", actorType: "agent", actorId: "worker-a", condition: "returning", arm: "generated", sourceRevision: "source-v1", rubricRevision: "rubric-v1", startedAt: "2026-11-12T10:00:00Z", deadlineAt: "2026-11-12T11:00:00Z", status: "failed", humanMinutes: null, costUsd: null, guardrailFindings: null, ...extra });
const accepted = (id, at, extra = {}) => episode(id, { status: "accepted", artifactRevision: "artifact-v1", acceptance: { at, artifactRevision: "artifact-v1", rubricRevision: "rubric-v1", reviewerId: "reviewer" }, ...extra });
const summarize = episodes => summarizeOutcomeTrials({ schemaVersion: 1, episodes }, { asOf: cutoff });

test("completion denominator retains failures, abandoned and cancelled work, excluding immature early success", () => {
  const group = summarize([accepted("ok", "2026-11-12T10:30:00Z"), episode("fail"), episode("abandon", { status: "abandoned" }), episode("cancel", { status: "cancelled" }), accepted("early", "2026-11-12T10:20:00Z", { deadlineAt: "2026-11-12T13:00:00Z" })]).groups[0];
  assert.deepEqual(group.reviewedCompletion, { numerator: 1, denominator: 4, rate: .25 });
  assert.deepEqual(group.immature, { count: 1, earlyAccepted: 1 });
  assert.equal(group.timeToReviewedResult.acceptedCount, 1);
});

test("late accepted results remain late and unresolved ages accompany completed-only latency", () => {
  const group = summarize([accepted("late", "2026-11-12T11:30:00Z"), episode("pending", { status: "running" })]).groups[0];
  assert.equal(group.reviewedCompletion.numerator, 0);
  assert.equal(group.timeToReviewedResult.medianMs, 90 * 60 * 1000);
  assert.equal(group.timeToReviewedResult.lateAcceptedCount, 1);
  assert.deepEqual(group.pending, [{ outcomeId: "pending", ageMs: 2 * 60 * 60 * 1000, overdue: true }]);
});

test("unknown effort and costs cannot become zero or a complete per-outcome average", () => {
  const group = summarize([accepted("ok", "2026-11-12T10:30:00Z", { humanMinutes: 5, costUsd: 1 }), episode("fail")]).groups[0];
  assert.equal(group.totalHumanEffort.observedMinutes, 5);
  assert.equal(group.totalHumanEffort.observedEpisodes, 1);
  assert.equal(group.totalHumanEffort.meanMinutesPerEpisode, null);
  assert.equal(group.cost.usdPerAccepted, null);
  const complete = summarize([episode("a", { humanMinutes: 0 }), episode("b", { humanMinutes: 4 })]).groups[0];
  assert.equal(complete.totalHumanEffort.meanMinutesPerEpisode, 2);
});

test("retries cannot create duplicate successes, stale review cannot accept a changed artifact", () => {
  assert.throws(() => summarize([episode("same"), episode("same")]), /Duplicate/);
  assert.throws(() => summarize([accepted("stale", "2026-11-12T10:30:00Z", { artifactRevision: "changed" })]), /exact artifact/);
  assert.throws(() => summarize([accepted("self", "2026-11-12T10:30:00Z", { actorId: "reviewer", independentReviewRequired: true })]), /Independent/);
});

test("first use, returning, actor type and comparison arms stay separate", () => {
  const result = summarize([episode("a"), episode("b", { condition: "first-use" }), episode("c", { actorType: "script" }), episode("d", { arm: "repo" })]);
  assert.equal(result.groups.length, 4);
  assert.equal(result.totalStarted, 4);
  assert.deepEqual(summarize([]).groups, []);
});

test("future observations, invalid windows and missing measurements fail explicitly", () => {
  assert.throws(() => summarize([episode("future", { startedAt: "2026-11-13T10:00:00Z" })]), /window/);
  assert.throws(() => summarize([accepted("future-review", "2026-11-13T10:00:00Z")]), /acceptance time/);
  assert.throws(() => summarize([episode("missing", { humanMinutes: undefined })]), /use null/);
  assert.throws(() => summarizeOutcomeTrials({ schemaVersion: 1, episodes: [] }, { asOf: "2026-11-12 12:00" }), /asOf/);
});

test("unobserved guardrails remain unknown and a severe failure cannot be hidden by acceptance", () => {
  const finding = { severity: "severe", reason: "Synthetic unauthorized disclosure" };
  const group = summarize([episode("unobserved"), episode("failed", { guardrailFindings: [finding] })]).groups[0];
  assert.equal(group.guardrails.observedEpisodes, 1);
  assert.equal(group.guardrails.eligibleEpisodes, 2);
  assert.deepEqual(group.guardrails.findings, [{ outcomeId: "failed", ...finding }]);
  assert.throws(() => summarize([accepted("bad", "2026-11-12T10:30:00Z", { guardrailFindings: [finding] })]), /Severe guardrail/);
});
