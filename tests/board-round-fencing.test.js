// BOARD-ROUND-FENCING: Dot's four BOARD-3849 integrated cases (issue #3299
// comments 6230291361 + 6231093451), pinned failing-first against main
// cef1c096. The board's lifecycle operation identity was derived from
// (claim, deliveryGeneration, actor) alone — but #3867 made generation a
// per-round counter that release→reclaim resets to 0 while PRESERVING the
// recorded request outcomes, so a fresh round re-derives the released
// round's operation key: an identical bundle silently replays (the new
// delivery never lands), a changed bundle conflicts. The same derivation
// left verify keys round-blind, the first submissions carried none of the
// basis preconditions the route enforces for release/reassign, Deliver
// reported success without state confirmation, and a criteria-bearing
// self-attested finish offered only a bundle-less Done the kernel must
// refuse. Case (3)'s pins are helper/wiring level by design: the reconcile
// decision is a pure predicate, and the wiring is pinned on the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as boardUi from "../src/board-ui.js";
import { boardHtml, claimDeliverBody, claimVerifyBody, verifyRequestId } from "../src/board-ui.js";
import { createWork, claimWork, updateWork, releaseWork, deliveryDigest, claimHistoryLength } from "../server/work-claims.mjs";

const SHA = "a".repeat(64);
const NOW = Date.parse("2026-10-16T13:00:00Z");
const T1 = Date.parse("2026-10-16T10:00:00.000Z");
const T2 = Date.parse("2026-10-16T12:00:00.000Z");
const MIN = 60_000;

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
};
const worker = { id: "agent-1", manage: false, owner: false, write: true };

const bundleFields = (ref = "https://example.com/results/round") => {
  const form = new FormData();
  form.set("artifactKind", "report");
  form.set("artifactRef", ref);
  form.set("artifactSha256", SHA);
  form.append("checkName", "unit tests");
  form.append("checkResult", "pass");
  form.append("criterion", "met");
  return form;
};

// The release→same-owner reclaim journey (#3867's valid reproduction
// shape): round 1 delivers, the claim is released, the SAME owner claims
// it again and delivers a second time. Returns both rounds' displayed
// items and composed bodies.
function runJourney(secondRef) {
  let item = createWork({ id: "wc_round", title: "Round trip", reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "agent-1", now: T1 - 60 * MIN });
  item = claimWork(item, "agent-1", { now: T1 });
  item = updateWork(item, "agent-1", { state: "in_progress", now: T1 + 5 * MIN });
  const body1 = claimDeliverBody(item, bundleFields(), "agent-1");
  const delivered1 = updateWork(item, "agent-1", { ...body1, now: T1 + 10 * MIN });
  // The kernel's release requires the round basis — the same basis the
  // board's release button sends (and case (2) extends to verify/deliver).
  let round2 = releaseWork(delivered1, "agent-1", { expectedClaimedAt: delivered1.claimedAt,
    expectedHistoryLength: claimHistoryLength(delivered1), now: T1 + 60 * MIN });
  round2 = claimWork(round2, "agent-1", { now: T2 });
  round2 = updateWork(round2, "agent-1", { state: "in_progress", now: T2 + 5 * MIN });
  const body2 = claimDeliverBody(round2, bundleFields(secondRef), "agent-1");
  return { body1, delivered1, shown2: round2, body2 };
}

// --- (1) release→reclaim must mint a fresh operation key ---

test("(1) a fresh claim round mints a fresh deliver operation key", () => {
  const { body1, body2 } = runJourney();
  assert.notEqual(body2.requestId, body1.requestId,
    "release→reclaim resets deliveryGeneration to 0 while preserving outcomes, so a generation-only key re-derives the released round's key");
});

test("(1) round-2 delivery of the same bundle actually lands (no silent replay)", () => {
  const { shown2, body2 } = runJourney();
  const delivered2 = updateWork(shown2, "agent-1", { ...body2, now: T2 + 10 * MIN });
  assert.equal(delivered2.state, "delivered",
    "on the broken derivation the kernel replays round 1's recorded outcome and returns the still-in_progress item");
  assert.equal(delivered2.delivery.digest, deliveryDigest(body2.delivery));
});

test("(1) round-2 delivery of a changed bundle lands instead of conflicting", () => {
  const { shown2, body2 } = runJourney("https://example.com/results/round-2");
  const delivered2 = updateWork(shown2, "agent-1", { ...body2, now: T2 + 10 * MIN });
  assert.equal(delivered2.state, "delivered");
  assert.equal(delivered2.delivery.artifact.ref, "https://example.com/results/round-2");
});

test("(1) verify keys are round-bound: same generation, different round, different key", () => {
  const { delivered1, shown2 } = runJourney();
  assert.equal(delivered1.deliveryGeneration, 1);
  // The board's round-2 display of the same delivered claim: identical
  // claim, generation and bundle — only the round facts (claimedAt,
  // lifetime history) moved. A derivation that ignores them re-derives
  // round 1's verify key in round 2.
  const round2Shown = { ...delivered1, claimedAt: shown2.claimedAt, history: shown2.history };
  assert.equal(round2Shown.deliveryGeneration, delivered1.deliveryGeneration,
    "both rounds display generation 1 — generation is not a round identity");
  assert.notEqual(verifyRequestId(delivered1, "rev-1"), verifyRequestId(round2Shown, "rev-1"),
    "a round-2 verify must not replay a round-1 verify outcome");
});

test("(1) claim ids that sanitize to the same prefix still mint different keys", () => {
  const shown = id => ({ id, deliveryGeneration: 0, claimedAt: "2026-10-16T10:00:00.000Z", history: [] });
  assert.notEqual(verifyRequestId(shown("wc task/alpha"), "rev-1"), verifyRequestId(shown("wc task alpha"), "rev-1"),
    "sanitization + 40-char truncation must not merge two claims' operation keys");
});

// --- (2) stale first submissions carry the displayed round basis ---

const displayItem = (extra = {}) => ({
  id: "wc_basis", title: "Basis", state: "delivered", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [],
  deliveryGeneration: 1, claimedAt: "2026-10-16T10:00:00.000Z",
  history: [{ action: "claimed" }, { action: "state:in_progress" }, { action: "state:delivered" }],
  historyOmitted: 2, acceptanceCriteria: ["tests green"], ...extra,
});

test("(2) claimRoundBasis derives the round the board displayed", () => {
  assert.equal(typeof boardUi.claimRoundBasis, "function", "the shared basis helper exists");
  assert.deepEqual(boardUi.claimRoundBasis(displayItem()),
    { expectedClaimedAt: "2026-10-16T10:00:00.000Z", expectedHistoryLength: 5 },
    "claimedAt plus lifetime history (page + omitted) — the release/reassign idiom");
  assert.deepEqual(boardUi.claimRoundBasis({ id: "wc_basis" }), {},
    "no displayed round, no precondition fields");
});

test("(2) the verify body carries the displayed round basis", () => {
  const body = claimVerifyBody(displayItem(), "rev-1");
  assert.equal(body.expectedClaimedAt, "2026-10-16T10:00:00.000Z");
  assert.equal(body.expectedHistoryLength, 5);
});

test("(2) the deliver body carries the displayed round basis", () => {
  const body = claimDeliverBody(displayItem({ state: "in_progress" }), bundleFields(), "agent-1");
  assert.equal(body.expectedClaimedAt, "2026-10-16T10:00:00.000Z");
  assert.equal(body.expectedHistoryLength, 5);
});

// --- (3) Deliver success is state-confirmed (helper/wiring level) ---

const submittedBundle = {
  artifact: { kind: "report", ref: "https://example.com/results/round", sha256: SHA },
  checks: [{ name: "unit tests", result: "pass" }],
  criteria: [{ criterion: "tests green", status: "met" }],
};

test("(3) deliveryLanded confirms only this round's matching landed delivery", () => {
  assert.equal(typeof boardUi.deliveryLanded, "function", "the reconcile predicate exists");
  const submitted = { claimedAt: "2026-10-16T10:00:00.000Z", owner: "agent-1", delivery: submittedBundle };
  const landed = { state: "delivered", claimedAt: "2026-10-16T10:00:00.000Z", owner: "agent-1",
    delivery: { ...submittedBundle, digest: "d".repeat(64), deliveredBy: "agent-1", deliveredAt: "2026-10-16T10:10:00.000Z" } };
  assert.equal(boardUi.deliveryLanded(landed, submitted), true, "the refreshed claim shows this delivery: success may be reported");
  assert.equal(boardUi.deliveryLanded({ ...landed, state: "done" }, submitted), true, "verified-after-delivery also confirms");
  assert.equal(boardUi.deliveryLanded({ ...landed, state: "in_progress", delivery: null }, submitted), false,
    "a lost response with no landed delivery is not a success");
  assert.equal(boardUi.deliveryLanded({ ...landed, claimedAt: "2026-10-16T12:00:00.000Z" }, submitted), false,
    "a different round's delivery does not confirm this submission");
  assert.equal(boardUi.deliveryLanded({ ...landed, delivery: { ...landed.delivery,
    artifact: { ...landed.delivery.artifact, ref: "https://example.com/results/other" } } }, submitted), false,
    "a different bundle does not confirm this submission");
  assert.equal(boardUi.deliveryLanded(null, submitted), false);
});

test("(3) the deliver submit wires reconciliation with unconfirmed copy", () => {
  const source = readFileSync(new URL("../src/board-ui.js", import.meta.url), "utf8");
  assert.match(source, /board\.action\.deliver\.unconfirmed/,
    "the deliver branch reports an unconfirmed outcome instead of assuming success or failure");
});

// --- (4) criteria-bearing self-attested finish carries a bundle ---

const finishClaim = (extra = {}) => ({
  id: "wc_fin", title: "Finish me", state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: "2026-10-16T10:00:00.000Z", reviewPolicy: "self_attested",
  acceptanceCriteria: ["tests green"], ...extra,
});

test("(4) a criteria-bearing self-attested claim offers the bundle form, not the bare Done", () => {
  const html = boardHtml([finishClaim()], null, worker, members, NOW);
  assert.match(html, /data-claim-deliver="wc_fin"/, "the holder gets the bundle entry form");
  assert.match(html, /data-claim-finish="done"/, "…marked as the finish (collapse) variant");
  assert.doesNotMatch(html, /data-claim-action="done"/,
    "the bare Done posts no bundle and the kernel must refuse it delivery_incomplete");
});

test("(4) the failure shape today: bare done on a criteria-bearing self-attested claim is refused", () => {
  let item = createWork({ id: "wc_fin0", reviewPolicy: "self_attested",
    acceptanceCriteria: ["tests green"] }, { agentId: "agent-1", now: T1 - 60 * MIN });
  item = claimWork(item, "agent-1", { now: T1 });
  item = updateWork(item, "agent-1", { state: "in_progress", now: T1 + 5 * MIN });
  assert.throws(() => updateWork(item, "agent-1", { state: "done", now: T1 + 10 * MIN }),
    error => error.code === "delivery_incomplete");
});

test("(4) claimFinishBody composes a collapse the kernel accepts, bundle frozen", () => {
  assert.equal(typeof boardUi.claimFinishBody, "function", "the finish body builder exists");
  let item = createWork({ id: "wc_fin", reviewPolicy: "self_attested",
    acceptanceCriteria: ["tests green"] }, { agentId: "agent-1", now: T1 - 60 * MIN });
  item = claimWork(item, "agent-1", { now: T1 });
  item = updateWork(item, "agent-1", { state: "in_progress", now: T1 + 5 * MIN });
  const body = boardUi.claimFinishBody(item, bundleFields(), "agent-1");
  assert.equal(body.state, "done");
  assert.equal(body.expectedClaimedAt, item.claimedAt, "the finish also carries the round basis");
  const done = updateWork(item, "agent-1", { ...body, now: T1 + 10 * MIN });
  assert.equal(done.state, "done");
  assert.equal(done.delivery.digest, deliveryDigest(body.delivery), "the bundle froze onto the finished claim");
});
