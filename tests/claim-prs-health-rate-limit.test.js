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

// F6 (CN-8): the degraded state had no age dimension — a rate-limit
// stretch that began a minute ago read exactly like one running for
// days. degradedSince stamps the tick that entered the state, holds
// across ticks that stay degraded, and clears when the state does.
test("degradedSince stamps the start of the degraded stretch, holds across ticks, and clears on recovery", () => {
  const tick = (at, summary) => [{ job: "claim-prs", ok: true, at, summary }];
  const row = (stored, at) => jobHealthView(stored, at).jobs.find(job => job.name === "claim-prs");
  const t0 = NOW - 170_000;
  // Healthy ticks carry no stamp.
  let stored = applyOutcomes({}, tick(t0, { checked: 3, updated: 1 }));
  assert.equal(row(stored, t0).status, "ok");
  assert.equal(row(stored, t0).degradedSince, null);
  // The tick that enters the degraded state stamps it.
  stored = applyOutcomes(stored, tick(t0 + 30_000, { checked: 0, updated: 0, rateLimited: true }));
  assert.equal(row(stored, t0 + 30_000).status, "degraded");
  assert.equal(row(stored, t0 + 30_000).degradedSince, new Date(t0 + 30_000).toISOString());
  // Later degraded ticks do not move the stamp.
  stored = applyOutcomes(stored, tick(t0 + 60_000, { checked: 0, updated: 0, rateLimited: true }));
  stored = applyOutcomes(stored, tick(t0 + 90_000, { checked: 0, updated: 0, rateLimited: true }));
  assert.equal(row(stored, t0 + 90_000).status, "degraded");
  assert.equal(row(stored, t0 + 90_000).degradedSince, new Date(t0 + 30_000).toISOString());
  // Recovery clears the stamp with the state.
  stored = applyOutcomes(stored, tick(t0 + 120_000, { checked: 2, updated: 1 }));
  assert.equal(row(stored, t0 + 120_000).status, "ok");
  assert.equal(row(stored, t0 + 120_000).degraded, null);
  assert.equal(row(stored, t0 + 120_000).degradedSince, null);
  // A later stretch gets its own start, not the first stretch's.
  stored = applyOutcomes(stored, tick(t0 + 150_000, { checked: 0, updated: 0, rateLimited: true }));
  assert.equal(row(stored, t0 + 150_000).status, "degraded");
  assert.equal(row(stored, t0 + 150_000).degradedSince, new Date(t0 + 150_000).toISOString());
});

test("a failing tick ends the degraded stretch and clears its stamp", () => {
  const t0 = NOW - 120_000;
  let stored = applyOutcomes({}, [{ job: "claim-prs", ok: true, at: t0, summary: { checked: 0, updated: 0, rateLimited: true } }]);
  let row = jobHealthView(stored, t0).jobs.find(job => job.name === "claim-prs");
  assert.equal(row.degradedSince, new Date(t0).toISOString());
  stored = applyOutcomes(stored, [{ job: "claim-prs", ok: false, at: t0 + 30_000, error: "boom" }]);
  row = jobHealthView(stored, t0 + 30_000).jobs.find(job => job.name === "claim-prs");
  assert.equal(row.status, "failing");
  assert.equal(row.degraded, null);
  assert.equal(row.degradedSince, null);
});
