// PERF-10X L12 / Lane 8 C4 — alarm past-due tail. earliestFutureAlarm used
// to push EVERY past-due fast job out by a full cadence (+60 s), so an
// already-due webhook retry / land poll / claim poll inherited up to a
// minute of pure latency tail on top of the backoff its due time already
// encoded. Now: a job with an explicit nextDueAt arms at
// now + PAST_DUE_ALARM_MS when past due; a cadence-only job keeps the
// one-cadence push-out (its cadence is the schedule — a finished tick must
// not schedule an immediate loop); future due times are never moved.
import test from "node:test";
import assert from "node:assert/strict";
import {
  JOBS, MINUTE_MS, PAST_DUE_ALARM_MS,
  earliestFutureAlarm, jobByName
} from "../server/jobs.mjs";

// Fixed "now" ahead of the wall clock so the registry helpers that read
// Date.now() internally (land-queue's enabled gate) stay deterministic.
const NOW = 1_800_000_000_000;
const STORE = {}; // jobNextDue only consults nextDueAt when a store exists

function fakeJob({ name = "fake", cadenceMs = MINUTE_MS, nextDueAt = undefined, slow = false, runtimes = ["worker"], enabled = () => true }) {
  const job = { name, cadenceMs, slow, runtimes, enabled, disabledReason: () => "off", run: async () => ({}) };
  if (nextDueAt !== undefined) job.nextDueAt = nextDueAt;
  return job;
}

const arm = (jobs, opts = {}) => earliestFutureAlarm(jobs, { env: {}, store: STORE, now: NOW, lastRan: {}, ...opts });

test("the past-due epsilon is ~now, not a cadence", () => {
  assert.ok(PAST_DUE_ALARM_MS > 0);
  assert.ok(PAST_DUE_ALARM_MS <= 5000, `epsilon ${PAST_DUE_ALARM_MS} must stay in Lane 8 C4's 1-5 s band`);
  assert.ok(PAST_DUE_ALARM_MS < MINUTE_MS);
});

test("an already-due explicit-nextDueAt job arms at ~now (60 s tail -> ~0)", () => {
  const job = fakeJob({ nextDueAt: () => NOW - 30_000 });
  assert.equal(arm([job]), NOW + PAST_DUE_ALARM_MS);
});

test("an explicit job due exactly now arms at ~now", () => {
  const job = fakeJob({ nextDueAt: () => NOW });
  assert.equal(arm([job]), NOW + PAST_DUE_ALARM_MS);
});

test("a future explicit due time is armed unchanged", () => {
  const job = fakeJob({ nextDueAt: () => NOW + 30_000 });
  assert.equal(arm([job]), NOW + 30_000);
});

test("a cadence-only job past due keeps the one-cadence push-out (no immediate loop)", () => {
  const job = fakeJob({});
  assert.equal(arm([job], { lastRan: { fake: NOW - 10 * MINUTE_MS } }), NOW + MINUTE_MS);
});

test("a cadence-only job not yet due arms at last run + cadence, unchanged", () => {
  const job = fakeJob({});
  assert.equal(arm([job], { lastRan: { fake: NOW - 20_000 } }), NOW + 40_000);
});

test("slow, disabled, other-runtime, and due-less jobs never arm the alarm", () => {
  assert.equal(arm([fakeJob({ name: "slow", slow: true, nextDueAt: () => NOW - 1000 })]), null);
  assert.equal(arm([fakeJob({ name: "off", enabled: () => false, nextDueAt: () => NOW - 1000 })]), null);
  assert.equal(arm([fakeJob({ name: "nodey", runtimes: ["node"], nextDueAt: () => NOW - 1000 })]), null);
  assert.equal(arm([fakeJob({ name: "idle", nextDueAt: () => null })]), null);
});

test("the earliest arm wins: past-due explicit beats cadence push-out and future dues", () => {
  const jobs = [
    fakeJob({ name: "cadence", cadenceMs: MINUTE_MS }),
    fakeJob({ name: "future", nextDueAt: () => NOW + 45_000 }),
    fakeJob({ name: "due", nextDueAt: () => NOW - 5_000 })
  ];
  assert.equal(arm(jobs, { lastRan: { cadence: NOW - 10 * MINUTE_MS } }), NOW + PAST_DUE_ALARM_MS);
});

test("notBefore floors a named job at its retry time without moving other jobs", () => {
  const due = fakeJob({ name: "due", nextDueAt: () => NOW - 5_000 });
  const other = fakeJob({ name: "other", nextDueAt: () => NOW + 30_000 });
  // The job that just threw re-arms at the retry delay, not the epsilon —
  // a poison item that stays past-due must not tight-loop.
  assert.equal(arm([due], { notBefore: new Map([["due", NOW + MINUTE_MS]]) }), NOW + MINUTE_MS);
  assert.equal(arm([due], { notBefore: { due: NOW + MINUTE_MS } }), NOW + MINUTE_MS);
  // An unnamed job's sooner due time still wins over the floored job.
  assert.equal(arm([due, other], { notBefore: new Map([["due", NOW + MINUTE_MS]]) }), NOW + 30_000);
  // A floor below the computed arm changes nothing.
  assert.equal(arm([other], { notBefore: new Map([["other", NOW + 1000]]) }), NOW + 30_000);
});

// --- The real registry, one fake store per scenario -----------------------

function storeWith({ webhookDue = null, landDue = null, landRateLimitedUntil = null, claimDue = null, channelHit = false, backfillDone = true, reseedDue = false } = {}) {
  return {
    db: {
      prepare(sql) {
        return {
          get() {
            if (sql.includes("agent_webhook_deliveries")) return { due: webhookDue };
            if (sql.includes("MAX(rate_limited_until)")) return { until: landRateLimitedUntil };
            if (sql.includes("FROM land_queue")) return landDue == null ? { due: null, n: 0 } : { due: landDue, n: 1 };
            if (sql.includes("FROM work_claims")) return claimDue == null ? { due: null, n: 0 } : { due: claimDue, n: 1 };
            if (sql.includes("pending_channel_updates")) return channelHit ? { hit: 1 } : null;
            if (sql.includes("public_read_model_backfill")) return { done: backfillDone ? 1 : 0 };
            return null;
          }
        };
      }
    },
    publicWorkClaims: {
      starterPoolStatus: () => ({ available: true, anchored: 1, claimable: 0, due: reseedDue ? ["seed"] : [] })
    }
  };
}

const armOne = (name, store, opts = {}) =>
  earliestFutureAlarm([jobByName(name)], { env: {}, store, now: NOW, lastRan: {}, ...opts });

test("registry: webhook-dispatch past due arms at ~now; future due unchanged; nothing waiting arms nothing", () => {
  assert.equal(armOne("webhook-dispatch", storeWith({ webhookDue: NOW - 30_000 })), NOW + PAST_DUE_ALARM_MS);
  assert.equal(armOne("webhook-dispatch", storeWith({ webhookDue: NOW + 30_000 })), NOW + 30_000);
  assert.equal(armOne("webhook-dispatch", storeWith({})), null);
});

test("registry: land-queue past due arms at ~now; future poll and rate-limit horizon unchanged", () => {
  assert.equal(armOne("land-queue", storeWith({ landDue: NOW - 30_000 })), NOW + PAST_DUE_ALARM_MS);
  assert.equal(armOne("land-queue", storeWith({ landDue: NOW + 45_000 })), NOW + 45_000);
  // The rate-limit horizon is the job's own load-spreading delay: a future
  // horizon is armed exactly, never accelerated.
  assert.equal(armOne("land-queue", storeWith({ landDue: NOW - 30_000, landRateLimitedUntil: NOW + 300_000 })), NOW + 300_000);
  assert.equal(armOne("land-queue", storeWith({})), null);
});

test("registry: claim-prs past due arms at ~now; future poll unchanged", () => {
  assert.equal(armOne("claim-prs", storeWith({ claimDue: NOW - 30_000 })), NOW + PAST_DUE_ALARM_MS);
  assert.equal(armOne("claim-prs", storeWith({ claimDue: NOW + 240_000 })), NOW + 240_000);
});

test("registry: cadence-only kinds keep the push-out when past due and their exact cadence when not", () => {
  const cases = [
    ["gmail-sync", storeWith({}), { env: { ROOM_GMAIL_ENABLED: "1" } }],
    ["channel-drain", storeWith({ channelHit: true }), {}],
    ["public-read-model", storeWith({ backfillDone: false }), {}],
    ["public-work-reseed", storeWith({ reseedDue: true }), {}]
  ];
  for (const [name, store, extra] of cases) {
    const job = jobByName(name);
    assert.equal(typeof job.nextDueAt, "undefined", `${name} is cadence-only`);
    assert.equal(
      earliestFutureAlarm([job], { env: {}, store, now: NOW, lastRan: { [name]: NOW - 10 * MINUTE_MS }, ...extra }),
      NOW + MINUTE_MS, `${name} past due keeps the cadence push-out`);
    assert.equal(
      earliestFutureAlarm([job], { env: {}, store, now: NOW, lastRan: { [name]: NOW - 20_000 }, ...extra }),
      NOW + 40_000, `${name} not yet due arms at last run + cadence`);
  }
  // gmail-sync stays off without its env gate.
  assert.equal(armOne("gmail-sync", storeWith({}), { lastRan: { "gmail-sync": 0 } }), null);
});

test("registry: slow kinds never arm the alarm, however past due", () => {
  for (const name of ["retention", "integrity", "room-backup"]) {
    assert.equal(armOne(name, storeWith({}), { lastRan: { [name]: 0 } }), null, name);
  }
  // growth-watch is node-only: no worker alarm.
  assert.equal(armOne("growth-watch", storeWith({}), { lastRan: { "growth-watch": 0 } }), null);
});

test("registry: full JOBS list — one past-due webhook sets the arm at ~now over cadence push-outs", () => {
  const store = storeWith({ webhookDue: NOW - 5_000, backfillDone: false, channelHit: true, reseedDue: true });
  const lastRan = Object.fromEntries(JOBS.map(job => [job.name, NOW - 10 * MINUTE_MS]));
  assert.equal(
    earliestFutureAlarm(JOBS, { env: { ROOM_GMAIL_ENABLED: "1" }, store, now: NOW, lastRan }),
    NOW + PAST_DUE_ALARM_MS);
  // And with the webhook floored at its retry time (it just threw), the arm
  // is the retry time / cadence push-out, never the epsilon.
  assert.equal(
    earliestFutureAlarm(JOBS, {
      env: { ROOM_GMAIL_ENABLED: "1" }, store, now: NOW, lastRan,
      notBefore: new Map([["webhook-dispatch", NOW + MINUTE_MS]])
    }),
    NOW + MINUTE_MS);
});
