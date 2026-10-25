// Health page truthfulness: a single known quarantine is degraded, a
// failing job names when the streak started and what to do, and the
// rollup is the worst status among the jobs that have to stay healthy.
import test from "node:test";
import assert from "node:assert/strict";
import { ONE_QUARANTINE_ACTION } from "../server/jobs.mjs";
import { CRON_JOBS, applyOutcomes, jobHealthResponse, jobHealthView, rollupJobStatus } from "../cloudflare/job-heartbeat.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");

function storedAt(now, patch = {}) {
  return applyOutcomes({}, CRON_JOBS.map(job => ({
    job: job.name,
    ok: true,
    at: now,
    summary: { checked: 1 },
    quarantineEventId: null,
    ...(patch[job.name] ?? {}),
  })));
}

function integrityOf(stored, now = NOW) {
  return jobHealthView(stored, now).jobs.find(job => job.name === "integrity");
}

test("one quarantined event is degraded, names the event, and omits the room", () => {
  const stored = storedAt(NOW, {
    integrity: {
      summary: { checked: 1, blockedRooms: 0, quarantinedEvents: 1, roomId: "muse-room" },
      quarantineEventId: "ev-old",
    },
  });
  const view = jobHealthView(stored, NOW);
  const integrity = integrityOf(stored);
  assert.equal(integrity.status, "degraded");
  assert.equal(integrity.degraded, "one_quarantined_event");
  assert.equal(integrity.quarantineEventId, "ev-old");
  assert.equal(integrity.failingSince, null);
  assert.equal(integrity.action, ONE_QUARANTINE_ACTION);
  assert.equal(view.status, "degraded");
  assert.equal(jobHealthResponse(view).status, 200);
  assert.equal(JSON.stringify(view).includes("muse-room"), false);
});

test("two quarantined events are not the single-event degraded case", () => {
  const integrity = integrityOf(storedAt(NOW, {
    integrity: { summary: { checked: 1, blockedRooms: 0, quarantinedEvents: 2 }, quarantineEventId: "ev-old" },
  }));
  assert.equal(integrity.status, "ok");
  assert.equal(integrity.quarantineEventId, null);
  assert.equal(integrity.action, null);
});

test("a real integrity failure stays failing beside one quarantined event", () => {
  // A tick a few seconds after a fresh success is failing, not stale:
  // the shortest worker period is one minute, and stale is three periods.
  const first = NOW + 30_000;
  let stored = applyOutcomes(storedAt(NOW), [{
    job: "integrity",
    ok: false,
    at: first,
    error: "scanError: integrity messages_backfill failed (messages_backfill_failed)",
    summary: { blockedRooms: 1, quarantinedEvents: 1 },
    failure: { code: "messages_backfill_failed", subcheck: "messages_backfill", errorClass: "integrity_mismatch", recordClass: "message" },
    quarantineEventId: "ev-old",
  }]);
  let integrity = integrityOf(stored, first);
  assert.equal(integrity.status, "failing");
  assert.equal(integrity.quarantineEventId, null);
  assert.equal(integrity.failingSince, new Date(first).toISOString());
  assert.match(integrity.action, /parked messages backfill/);
  assert.equal(jobHealthView(stored, first).status, "failing");
  assert.equal(jobHealthResponse(jobHealthView(stored, first)).status, 503);

  const second = NOW + 60_000;
  stored = applyOutcomes(stored, [{
    job: "integrity",
    ok: false,
    at: second,
    error: "scanError: integrity messages_backfill failed (messages_backfill_failed)",
    summary: { blockedRooms: 1, quarantinedEvents: 1 },
    failure: { code: "messages_backfill_failed", subcheck: "messages_backfill" },
    quarantineEventId: null,
  }]);
  integrity = integrityOf(stored, second);
  assert.equal(integrity.consecutiveFailures, 2);
  assert.equal(integrity.failingSince, new Date(first).toISOString());
  assert.equal(jobHealthView(stored, second).status, "failing");
});

test("a failing streak recorded before failingSince still shows the last success", () => {
  const old = Date.parse("2026-10-11T19:30:00.000Z");
  // A store makes the just-run job waiting, which is how production keeps
  // a long streak at failing instead of stale. The empty store disables
  // work-gated jobs; integrity stays enabled.
  const integrity = jobHealthView({
    integrity: {
      lastRunAt: NOW, lastSuccessAt: old, lastErrorAt: NOW, consecutiveFailures: 281,
      lastError: "scanError: integrity messages_backfill failed (messages_backfill_failed)",
      lastFailure: { code: "messages_backfill_failed", subcheck: "messages_backfill" },
    },
  }, NOW, {}, {}).jobs.find(job => job.name === "integrity");
  assert.equal(integrity.status, "failing");
  assert.equal(integrity.failingSince, new Date(old).toISOString());
  assert.equal(typeof integrity.action, "string");
  assert.equal(integrity.action.includes("\n"), false);
});

test("store-growth failing is worse than a single quarantine, and a recovery clears the streak", () => {
  const failedAt = NOW + 1000;
  const stored = applyOutcomes(storedAt(NOW, {
    integrity: {
      summary: { checked: 1, blockedRooms: 0, quarantinedEvents: 1 },
      quarantineEventId: "ev-old",
    },
  }), [{
    job: "store-growth",
    ok: false,
    at: failedAt,
    error: "store growth limit",
    failure: { code: "store_growth_limit" },
    summary: { maxProjectionBytes: 3_807_861 },
    quarantineEventId: null,
  }]);
  const view = jobHealthView(stored, failedAt);
  assert.equal(view.jobs.find(job => job.name === "integrity").status, "degraded");
  const growth = view.jobs.find(job => job.name === "store-growth");
  assert.equal(growth.status, "failing");
  assert.match(growth.action, /store-growth/);
  assert.equal(growth.failingSince, new Date(failedAt).toISOString());
  assert.equal(view.status, "failing");

  const recoveredAt = NOW + 2000;
  const recovered = applyOutcomes(stored, [{ job: "store-growth", ok: true, at: recoveredAt, summary: { checked: 1 }, quarantineEventId: null }]);
  const after = jobHealthView(recovered, recoveredAt);
  assert.equal(after.jobs.find(job => job.name === "store-growth").status, "ok");
  assert.equal(after.jobs.find(job => job.name === "store-growth").failingSince, null);
  assert.equal(after.status, "degraded");
});

test("rollup status is the worst of the jobs that count", () => {
  assert.equal(rollupJobStatus([{ status: "ok" }, { status: "degraded" }, { status: "disabled" }]), "degraded");
  assert.equal(rollupJobStatus([{ status: "degraded" }, { status: "failing" }]), "failing");
  assert.equal(rollupJobStatus([{ status: "failing" }, { status: "stale" }]), "stale");
  assert.equal(rollupJobStatus([{ status: "ok" }, { status: "disabled", required: true }]), "failing");
  assert.equal(rollupJobStatus([{ status: "ok" }, { status: "disabled", required: false }]), "ok");
});
