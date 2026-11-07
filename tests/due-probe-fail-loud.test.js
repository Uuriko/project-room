// B8-4/B8-5 (methods audit, Phase B): the fail-soft due-probe family.
// Six catch-alls turned ANY store error into the legitimate "nothing due"
// value — null / false / "Not configured" — with no log line, so a corrupt
// or locked store stalled escrow epochs, webhook/channel/land/claim drains
// and the stale-claim sweep indefinitely and invisibly (B8-5 executed the
// forced failures: summaries deep-equal to legitimate-empty controls, zero
// log lines, exit 0).
//
// The cure adopts the house discrimination already used by the sibling
// sites in claim-pr-sync / claim-autolink / sleeper-wake: a missing table
// is a legitimate cold store and still reads as empty; every other error
// surfaces — the probes throw, the registry wrappers log (naming the job
// and probe) and rethrow, and the iterating consumers (scheduler pass,
// health views, alarm arming) isolate the failure per job into their
// existing failure channels instead of fabricating an empty result.
import test from "node:test";
import assert from "node:assert/strict";
import { escrowEpochNextDueAt, progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";
import { JOBS, jobByName, jobEnabled, jobNextDue, jobIsDue, jobDisabledReason, earliestFutureAlarm, startNodeScheduler } from "../server/jobs.mjs";
import { staleSweepDueAt } from "../server/claim-pr-sync.mjs";
import { jobHealthView, selectWorkerJobs } from "../cloudflare/job-heartbeat.mjs";

const NOW = 1_800_000_000_000;
const PAST = NOW - 60_000;
const EMPTY_SUMMARY = { rooms: 0, due: 0, approved: 0, paid: 0, refunded: 0, released: 0, expired: 0, failed: 0, errors: 0, overdue: 0 };

// A store whose every statement fails the way a corrupt / locked /
// schema-broken store fails — NOT the cold-store missing-table case.
function throwingStore(message = "forced store failure: database is locked") {
  return { workClaims: {}, db: { prepare() { throw new Error(message); } } };
}
// A cold store: the probed tables have never been created.
function missingTableStore() {
  return { workClaims: {}, db: { prepare(sql) { throw new Error(`no such table: ${String(sql).includes("bounty") ? "bounty_records" : "probed_table"}`); } } };
}
// In-memory semantics for the controls (mirrors B8-5's due store): one
// webhook delivery due in the past, one stale claim; escrow COUNT reads 0.
function dueStore() {
  return {
    workClaims: {},
    db: {
      prepare(sql) {
        const s = String(sql);
        return {
          all() { if (s.includes("COUNT(*)")) return [{ n: 0 }]; return []; },
          get() {
            if (s.includes("agent_webhook_deliveries")) return { due: PAST };
            if (s.includes("work_claims")) return { activityMs: PAST - 40 * 24 * 3600 * 1000 };
            return undefined;
          }
        };
      }
    }
  };
}

function captureConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(a => String(a)).join(" ")); };
  try { return { value: fn(), lines }; }
  finally { console.error = original; }
}

// ---- bounty-epoch-keeper.mjs query() ------------------------------------

test("keeper: a store error surfaces from escrowEpochNextDueAt instead of reading as nothing due", () => {
  assert.throws(() => escrowEpochNextDueAt(throwingStore(), NOW), /forced store failure/);
});

test("keeper: a store error surfaces from progressEscrowEpochs instead of an empty summary", () => {
  assert.throws(() => progressEscrowEpochs(throwingStore(), { now: NOW }), /forced store failure/);
});

test("keeper: a missing escrow table still reads as legitimate empty", () => {
  assert.equal(escrowEpochNextDueAt(missingTableStore(), NOW), null);
  assert.deepEqual(progressEscrowEpochs(missingTableStore(), { now: NOW }), EMPTY_SUMMARY);
});

// ---- jobs.mjs read() via the real registered jobs ------------------------

test("jobs read(): a store error surfaces through the webhook-dispatch probes", () => {
  const job = jobByName("webhook-dispatch");
  assert.throws(() => jobEnabled(job, {}, throwingStore()), /forced store failure/);
  assert.throws(() => jobNextDue(job, throwingStore(), NOW), /forced store failure/);
  assert.throws(() => jobIsDue(job, throwingStore(), NOW), /forced store failure/);
});

test("jobs read(): missing tables still read as nothing due, and due work still reads due", () => {
  const job = jobByName("webhook-dispatch");
  assert.equal(jobEnabled(job, {}, missingTableStore()), false);
  assert.equal(jobNextDue(job, missingTableStore(), NOW), null);
  assert.equal(jobIsDue(job, missingTableStore(), NOW), false);
  assert.equal(jobEnabled(job, {}, dueStore()), true);
  assert.equal(jobNextDue(job, dueStore(), NOW), PAST);
  assert.equal(jobIsDue(job, dueStore(), NOW), true);
});

test("jobs read(): a store error surfaces through the claim-prs probes", () => {
  const job = jobByName("claim-prs");
  assert.throws(() => jobEnabled(job, {}, throwingStore()), /forced store failure/);
});

// ---- jobs.mjs wrappers jobEnabled / jobNextDue / jobDisabledReason -------

const throwingJob = {
  name: "proof-throwing", cadenceMs: 60_000,
  enabled() { throw new Error("forced enabled() failure"); },
  disabledReason() { throw new Error("forced disabledReason() failure"); },
  nextDueAt() { throw new Error("forced nextDueAt() failure"); }
};

test("jobEnabled: a throwing enabled() is logged and rethrown, never read as disabled", () => {
  const { lines } = captureConsoleError(() =>
    assert.throws(() => jobEnabled(throwingJob, {}, dueStore()), /forced enabled\(\) failure/));
  assert.ok(lines.some(line => line.includes("proof-throwing")), `expected a log line naming the job, got ${JSON.stringify(lines)}`);
});

test("jobNextDue: a throwing nextDueAt() is logged and rethrown, never read as nothing queued", () => {
  const { lines } = captureConsoleError(() =>
    assert.throws(() => jobNextDue(throwingJob, dueStore(), NOW), /forced nextDueAt\(\) failure/));
  assert.ok(lines.some(line => line.includes("proof-throwing")), `expected a log line naming the job, got ${JSON.stringify(lines)}`);
});

test("jobDisabledReason: a throwing disabledReason() is logged and rethrown, never fabricated as 'Not configured'", () => {
  const job = { name: "proof-s5", cadenceMs: 60_000, enabled: () => false, disabledReason() { throw new Error("forced disabledReason() failure"); } };
  const { lines } = captureConsoleError(() =>
    assert.throws(() => jobDisabledReason(job, {}, null), /forced disabledReason\(\) failure/));
  assert.ok(lines.some(line => line.includes("proof-s5")), `expected a log line naming the job, got ${JSON.stringify(lines)}`);
});

test("jobDisabledReason: genuine reasons survive and a blank reason still defaults", () => {
  const real = { name: "proof-real", cadenceMs: 60_000, enabled: () => false, disabledReason: () => "No webhook delivery is waiting" };
  assert.equal(jobDisabledReason(real, {}, null), "No webhook delivery is waiting");
  const blank = { name: "proof-blank", cadenceMs: 60_000, enabled: () => false, disabledReason: () => null };
  assert.equal(jobDisabledReason(blank, {}, null), "Not configured");
  const on = { name: "proof-on", cadenceMs: 60_000, enabled: () => true, disabledReason() { throw new Error("must not be called"); } };
  assert.equal(jobDisabledReason(on, {}, null), null);
});

// ---- claim-pr-sync.mjs staleSweepDueAt() ---------------------------------

test("staleSweepDueAt: a store error surfaces instead of standing the sweep down silently", () => {
  assert.throws(() => staleSweepDueAt(throwingStore(), NOW), /forced store failure/);
});

test("staleSweepDueAt: a missing table still reads as no wake, and a stale claim still schedules one", () => {
  assert.equal(staleSweepDueAt(missingTableStore(), NOW), null);
  assert.ok(Number.isFinite(staleSweepDueAt(dueStore(), NOW)), "a stale claim schedules a wake");
});

// ---- consumers isolate a probe failure per job ---------------------------

test("selectWorkerJobs: one job's probe failure excludes only that job", () => {
  const names = selectWorkerJobs({}, throwingStore()).map(job => job.name);
  assert.ok(!names.includes("webhook-dispatch"), "the errored job is not selected");
  assert.ok(names.includes("integrity"), "jobs whose gate does not probe the store still run");
});

test("earliestFutureAlarm: one job's probe failure does not disarm the other jobs", () => {
  let alarm;
  assert.doesNotThrow(() => { alarm = earliestFutureAlarm(JOBS, { env: {}, store: throwingStore(), now: NOW, lastRan: {}, runtime: "worker" }); });
  assert.ok(alarm === null || Number.isFinite(alarm), `expected an alarm time or null, got ${alarm}`);
});

test("jobHealthView: a probe failure renders the job failing with its own reason, not disabled or ok", () => {
  const view = jobHealthView({}, NOW, {}, throwingStore());
  const webhook = view.jobs.find(job => job.name === "webhook-dispatch");
  assert.equal(webhook.status, "failing");
  assert.match(webhook.reason ?? "", /probe failed/i);
  assert.ok(webhook.lastError, "the probe error is carried on the health entry");
  const integrity = view.jobs.find(job => job.name === "integrity");
  assert.doesNotMatch(integrity.reason ?? "", /probe failed/i);
});

test("node scheduler: a probe failure is recorded as that job's failure and does not kill the pass", async () => {
  const scheduler = startNodeScheduler({ store: throwingStore(), env: {}, now: () => NOW });
  const outcomes = await scheduler.runOnce();
  const webhook = outcomes.find(outcome => outcome.job === "webhook-dispatch");
  assert.ok(webhook, "the pass produced an outcome for webhook-dispatch");
  assert.equal(webhook.ok, false);
  const health = scheduler.jobHealth().find(job => job.name === "webhook-dispatch");
  assert.ok(health.consecutiveFailures >= 1, `expected a counted failure, got ${JSON.stringify(health)}`);
  assert.ok(health.lastError, "the probe error is recorded on the job's health entry");
  assert.match(health.reason ?? "", /probe failed/i);
});
