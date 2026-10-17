// research r41 (claim-prs "degraded" since Oct 15): two readings of the
// health surface. (1) lastError is history and survives every later success,
// so the view now says whether it is current. (2) A GitHub secondary rate
// limit carries the primary window's reset (up to an hour away); the claim
// poll held until that reset instead of the retry-after GitHub sent.
import test from "node:test";
import assert from "node:assert/strict";
import { rateLimitUntil } from "../server/claim-coordination.mjs";
import { applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

const NOW = 1_790_000_000_000;
const resetIn = seconds => String(Math.floor(NOW / 1000) + seconds);

test("a secondary rate limit holds for retry-after, not until the primary reset", () => {
  const until = rateLimitUntil({ status: 403, remaining: "4100", reset: resetIn(3000),
    retryAfter: "60", message: "You have exceeded a secondary rate limit" }, NOW);
  assert.equal(until, NOW + 60_000);
});

test("a secondary rate limit without retry-after waits a minute, not up to an hour", () => {
  const until = rateLimitUntil({ status: 403, remaining: "4100", reset: resetIn(3000),
    message: "You have exceeded a secondary rate limit" }, NOW);
  assert.equal(until, NOW + 60_000);
});

test("a spent primary window still holds until its reset", () => {
  const until = rateLimitUntil({ status: 403, remaining: "0", reset: resetIn(3000) }, NOW);
  assert.equal(until, (Math.floor(NOW / 1000) + 3000) * 1000);
});

test("an old claim-prs error under a live degraded status is marked not current", () => {
  let stored = applyOutcomes({}, [{ job: "claim-prs", ok: false, at: NOW - 86_400_000, error: "repo must be 1..200 characters" }]);
  let row = jobHealthView(stored, NOW - 86_400_000 + 1000).jobs.find(job => job.name === "claim-prs");
  assert.equal(row.lastErrorCurrent, true);
  stored = applyOutcomes(stored, [{ job: "claim-prs", ok: true, at: NOW - 60_000, summary: { checked: 0, updated: 0, rateLimited: true } }]);
  row = jobHealthView(stored, NOW).jobs.find(job => job.name === "claim-prs");
  assert.equal(row.status, "degraded");
  assert.match(row.lastError, /repo must be/);
  assert.equal(row.lastErrorCurrent, false);
});
