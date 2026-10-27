// UT wave-2 L10: /api/health/jobs can answer 503 status:"stale" while no
// top-level field names WHICH required job is stale — an operator must scan
// the whole jobs array to find the one job whose staleness is a safety
// signal (today only room-backup carries required:true in the registry).
// The per-job rows already carry name/lastRunAt/required/stale; this pins a
// top-level staleRequiredJobs rollup in the same shape discipline, computed
// from the same view data. Status semantics are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { applyOutcomes, jobHealthResponse, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

// Fresh success records for every worker job EXCEPT the named ones, so the
// only staleness signal under test is the named jobs' absence.
const ALL_JOBS = ["gmail-sync", "channel-drain", "webhook-dispatch", "land-queue", "claim-prs",
  "retention", "integrity", "public-read-model", "public-work-reseed", "escrow-epochs",
  "room-backup", "patrol", "project-map", "store-growth"];
function freshExcept(now, except) {
  return applyOutcomes({}, ALL_JOBS.filter(name => !except.includes(name))
    .map(job => ({ job, ok: true, at: now, summary: { checked: 1 } })));
}

test("a stale required job is named at the top level of the health view", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  // room-backup has never run: no record at all.
  const view = jobHealthView(freshExcept(now, ["room-backup"]), now);
  assert.equal(view.status, "stale");
  assert.deepEqual(view.staleRequiredJobs, [{
    name: "room-backup",
    lastRunAt: null,
    lastSuccessAt: null,
    required: true,
    stale: true,
    status: "stale"
  }]);
});

test("a stale required job carries its last-run instants when it ran before", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const ranAt = now - 4 * 86400_000; // room-backup is daily; 4 days is past the 3-period stale line
  const stored = applyOutcomes(freshExcept(now, ["room-backup"]),
    [{ job: "room-backup", ok: true, at: ranAt, summary: { rooms: 1 } }]);
  const view = jobHealthView(stored, now);
  assert.deepEqual(view.staleRequiredJobs, [{
    name: "room-backup",
    lastRunAt: new Date(ranAt).toISOString(),
    lastSuccessAt: new Date(ranAt).toISOString(),
    required: true,
    stale: true,
    status: "stale"
  }]);
});

test("stale non-required jobs do not enter staleRequiredJobs", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const view = jobHealthView(freshExcept(now, ["patrol"]), now);
  assert.equal(view.status, "stale", "the patrol staleness still drives the rollup status");
  assert.deepEqual(view.staleRequiredJobs, []);
});

test("the 503 response body names the stale required job", async () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const view = jobHealthView(freshExcept(now, ["room-backup"]), now);
  const response = jobHealthResponse(view);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "stale");
  assert.deepEqual(body.staleRequiredJobs.map(job => job.name), ["room-backup"]);
  assert.equal(body.staleRequiredJobs[0].required, true);
  assert.equal(body.staleRequiredJobs[0].stale, true);
});

test("a healthy view carries an empty staleRequiredJobs list", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const view = jobHealthView(freshExcept(now, []), now);
  assert.equal(view.status, "ok");
  assert.deepEqual(view.staleRequiredJobs, []);
});
