// r36: claim-prs on prod (2026-10-17T10:51Z /api/health/jobs) read
// status "degraded" (github_rate_limited) with consecutiveFailures 0 and a
// lastError "repo must be 1..200 characters ..." stamped 2026-10-15T06:28Z.
// A success keeps lastError as history, and nothing in the view said the
// text was two days old and already cleared, so it was triaged as the
// current failure. lastErrorCurrent says whether lastError is live.
import test from "node:test";
import assert from "node:assert/strict";
import { applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

const T0 = Date.UTC(2026, 9, 15, 6, 28, 56);
const REPO_ERROR = "repo must be 1..200 characters of letters, numbers, or . _ / -";

function claimPrs(view) {
  return view.jobs.find(job => job.name === "claim-prs");
}

test("a later success marks the kept lastError as not current", () => {
  let stored = applyOutcomes({}, [{ job: "claim-prs", ok: false, at: T0, error: REPO_ERROR }]);
  stored = applyOutcomes(stored, [{ job: "claim-prs", ok: true, at: T0 + 60_000, summary: { checked: 0, updated: 0, rateLimited: true, skippedInvalid: 3 } }]);
  const job = claimPrs(jobHealthView(stored, T0 + 120_000));
  assert.equal(job.status, "degraded");
  assert.equal(job.lastError, REPO_ERROR, "history is kept");
  assert.equal(job.lastErrorCurrent, false);
});

test("a failing job marks lastError as current", () => {
  let stored = applyOutcomes({}, [{ job: "claim-prs", ok: true, at: T0 - 60_000, summary: { checked: 1, updated: 0 } }]);
  stored = applyOutcomes(stored, [{ job: "claim-prs", ok: false, at: T0, error: REPO_ERROR }]);
  const job = claimPrs(jobHealthView(stored, T0 + 30_000));
  assert.equal(job.status, "failing");
  assert.equal(job.lastErrorCurrent, true);
});

test("a job that never failed reports no current error", () => {
  const stored = applyOutcomes({}, [{ job: "claim-prs", ok: true, at: T0, summary: { checked: 1, updated: 0 } }]);
  const job = claimPrs(jobHealthView(stored, T0 + 30_000));
  assert.equal(job.lastError, null);
  assert.equal(job.lastErrorCurrent, false);
});
