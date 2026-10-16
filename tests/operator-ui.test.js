// COVERAGE CREW lane5: unit tests for the pure operator-console helpers in
// src/operator-ui.js (confirmationPhrase, describeFailure).
// Authoring gate: these guard the typed confirmation that arms the
// destructive purge execute (a phrase slip enables execute on the wrong
// input) and the user-facing failure messages (a wrong 404/429/409 mapping
// misleads the operator mid-purge). Existing coverage: none — tests/ has
// zero references to src/operator-ui.js. The rest of the module is DOM and
// network code behind document guards; imported here, the module never
// touches the DOM, so no stubs are needed.
import test from "node:test";
import assert from "node:assert/strict";
import { confirmationPhrase, describeFailure, summarizeSurface } from "../src/operator-ui.js";

test("confirmationPhrase: single-room plan with a known title requires the title", () => {
  const targets = [{ kind: "room", id: "rm_1" }];
  assert.equal(confirmationPhrase(targets, new Map([["rm_1", "The Lounge"]])), "The Lounge");
});

test("confirmationPhrase: single-room plan without a known title falls back to the id", () => {
  const targets = [{ kind: "room", id: "rm_1" }];
  assert.equal(confirmationPhrase(targets, new Map()), "rm_1");
  assert.equal(confirmationPhrase(targets), "rm_1");
});

test("confirmationPhrase: multi-target plans use the count phrase", () => {
  assert.equal(confirmationPhrase([{ kind: "room", id: "a" }, { kind: "identity", id: "b" }]), "purge 2 targets");
});

test("confirmationPhrase: a single non-room target uses the singular count phrase", () => {
  assert.equal(confirmationPhrase([{ kind: "identity", id: "i_1" }]), "purge 1 target");
});

test("describeFailure: known statuses map to operator-readable messages", () => {
  assert.equal(describeFailure(404, null), "The token was not accepted, or the operator surface is not configured on this deployment.");
  assert.equal(describeFailure(429, {}), "Too many operator calls from this address. Wait a minute and try again.");
  assert.equal(
    describeFailure(409, { error: { code: "plan_changed" } }),
    "The data changed after this plan was made. Nothing was deleted. Plan again."
  );
});

test("describeFailure: server errors surface the message or fall back to the status", () => {
  // BU-03: the fallthrough now resolves through the shared human error copy —
  // specific server messages pass through, everything else gets a
  // plain-language status sentence instead of "Refused (500): ...".
  assert.equal(describeFailure(500, { error: { message: "disk full" } }), "disk full");
  assert.equal(describeFailure(409, { error: { message: "stale revision" } }), "stale revision");
  assert.equal(describeFailure(503, null), "The service is temporarily unavailable. Try again in a moment.");
  assert.equal(describeFailure(500, {}), "Something went wrong on our side. Try again in a moment.");
});

// Status-surface summary (slice 4): the console renders the composed model
// through summarizeSurface; its honesty rules are pinned here — unrecorded
// facts read "not recorded", gaps are carried into the notes verbatim.
const SURFACE_BASE = {
  generatedAt: "2026-10-15T12:00:00.000Z",
  deployment: { deployment: "production", doors: { do: "abc1234", worker: "abc1234", state: "converged" } },
  jobs: { source: "worker-heartbeat", rows: [
    { name: "integrity", state: "failing", lastSuccessAt: "2026-10-11T19:30:55.000Z", lastErrorAt: "2026-10-15T11:00:00.000Z", lastErrorCode: "integrity_failed", consecutiveFailures: 77 }
  ] },
  integrity: { state: "failing", cursor: { nextStepIndex: 10, nextStepName: "messages_parity", stepsTotal: 11 }, snapshot: { verifiedAt: null }, lastFailingRoom: null, lastFailingRoomState: "not-recorded" },
  claimPrs: { state: "not-recorded", skippedInvalid: null, reason: "summary not retained" },
  backup: { state: "recorded", bytes: 89_650_000, at: "2026-10-14T03:00:00.000Z", marginDays: 2.6 },
  board: { state: "recorded", claimableCount: 3 },
  behaviour: { slis: [
    { id: "task-success", state: "not-recorded", burnState: null, gap: "no decided-outcome ledger" },
    { id: "cost-per-task", state: "recorded", burnState: null, observed: { approvedLots: 2, windowDays: 30 }, gap: "no budget" }
  ] }
};

test("summarizeSurface: failing job and unrecorded facts stay honest", () => {
  const { facts, jobRows, notes } = summarizeSurface(SURFACE_BASE);
  const fact = Object.fromEntries(facts);
  assert.equal(fact["Door drift"], "converged");
  assert.match(fact["Integrity"], /failing room not recorded/);
  assert.equal(fact["Integrity snapshot verified"], "not recorded");
  assert.equal(fact["claim-prs skipped rows"], "not recorded");
  assert.match(fact["Latest backup"], /89\.65 MB/);
  assert.match(fact["Backup margin"], /2\.6 days/);
  assert.equal(fact["Board claimable"], "3");
  assert.match(fact["Behaviour burn rates"], /not recorded/);
  assert.deepEqual(jobRows[0].slice(0, 2), ["integrity", "failing"]);
  assert.equal(jobRows[0][4], "77");
  assert.match(jobRows[0][3], /integrity_failed/);
  assert.ok(notes.some(note => note.includes("no decided-outcome ledger")), "SLI gaps reach the operator");
  assert.ok(notes.some(note => note.includes("2 lot(s) approved")), "observed SLI measure is shown");
});

test("summarizeSurface: an empty model renders not-recorded everywhere", () => {
  const { facts, jobRows, notes } = summarizeSurface({});
  const fact = Object.fromEntries(facts);
  assert.equal(fact["Revision (worker door)"], "not recorded");
  assert.equal(fact["Backup margin"], "not recorded");
  assert.equal(fact["Board claimable"], "not recorded");
  assert.deepEqual(jobRows, []);
  assert.deepEqual(notes, []);
});
