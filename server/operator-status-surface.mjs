// Operator status surface. One composed read of what is deployed and how
// the registered jobs are doing, assembled only from records the system
// already keeps: the stamped revision, the second version door read back
// over HTTP, and the job heartbeat / Node scheduler records.
//
// Honesty rules, shared with the receipts/proof surfaces:
// - A fact the records do not hold is rendered as an explicit not-recorded
//   state with the reason, never as a plausible-looking zero or a guess.
// - Every row carries the timestamps of the record it was read from, so a
//   stale row looks stale instead of quietly looking current.
// - The integrity failure `message` column is never republished here: it
//   is stored unredacted in the store, so this surface carries the stable
//   code, the step, and the record id only.
// - Behavioural SLIs render observed measures only. No SLO budget is
//   defined anywhere in code or config today, so every burn rate is null
//   (not-recorded) until a budget exists; burnState() below is the display
//   grammar (2x = alert, 10x = page) waiting for that input, not a number
//   invented in its place.

import { JOBS, INTEGRITY_SUBCHECKS, nodeJobHealth } from "./jobs.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { revisionDrift } from "./operator-status.mjs";

export const STATUS_SURFACE_SCHEMA = "room.operator-status/1";

// The deferred integrity batch (store.mjs runDeferredIntegrityBatch) runs
// eleven steps whose names are the first eleven INTEGRITY_SUBCHECKS, in the
// same order; the cursor stores the index of the next step to run.
export const INTEGRITY_STEP_NAMES = Object.freeze(INTEGRITY_SUBCHECKS.slice(0, 11));

// Steps whose isolated failures record a room id in record_id by
// construction (the INTEGRITY-NAMING lane's naming rule, from the
// batch-isolation recorder): messages_backfill, messages_parity, and
// help_history key their records by room; every other step keys by
// journal/invitation ids or records nothing per-room, so a "failing room"
// can only be named when the latest failure comes from one of these.
const ROOM_RECORD_STEPS = new Set(["messages_backfill", "messages_parity", "help_history"]);

const SLI_WINDOW_DAYS = 30;

// SRE burn grammar: a burn rate is the observed error rate divided by the
// budgeted one. 2x burns the budget twice as fast as allowed (alert), 10x
// exhausts a 30-day budget in ~3 days (page). Null in, null out — with no
// budget there is no burn, and the tiles say so.
export function burnState(rate) {
  if (!Number.isFinite(rate)) return null;
  if (rate >= 10) return "page";
  if (rate >= 2) return "alert";
  return "within-budget";
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const epoch = value => {
  if (Number.isFinite(value)) return iso(value);
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? iso(parsed) : value;
  }
  return null;
};

// The Worker door is answered from Worker module scope, so this process
// cannot read it from memory: it is read back over HTTP from this
// deployment's own public origin, the same read the deploy tooling makes
// (scripts/check-version-doors.mjs). Any failure is a null, rendered as an
// unknown door state — never as a revision.
export async function readWorkerDoorRevision(origin, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  if (typeof origin !== "string" || !origin || typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/version/worker`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response?.ok) return null;
    const revision = (await response.json())?.sourceRevision;
    return typeof revision === "string" && revision ? revision : null;
  } catch { return null; }
}

function jobRow(job, record) {
  const base = {
    name: job.name,
    periodSeconds: Math.round(job.cadenceMs / 1000),
    runtimes: job.runtimes,
    lastRunAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null,
    lastErrorCode: null, lastErrorSubcheck: null, consecutiveFailures: 0,
    lastDurationMs: null, lastSummaryAt: null
  };
  if (!record) {
    return { ...base, state: "not-recorded", reason: job.singleRuntimeReason ?? "No run recorded on this runtime" };
  }
  const row = {
    ...base,
    lastRunAt: epoch(record.lastRunAt), lastSuccessAt: epoch(record.lastSuccessAt),
    lastErrorAt: epoch(record.lastErrorAt), lastError: record.lastError ?? null,
    lastErrorCode: record.lastErrorCode ?? record.lastFailure?.code ?? null,
    lastErrorSubcheck: record.lastErrorSubcheck ?? record.lastFailure?.subcheck ?? null,
    consecutiveFailures: record.consecutiveFailures ?? 0,
    lastDurationMs: record.lastDurationMs ?? null,
    lastSummaryAt: epoch(record.lastSummaryAt)
  };
  // The Worker heartbeat view grades its own rows (status is present); the
  // Node scheduler deliberately does not grade health, so its rows derive
  // only the states its records can honestly support.
  if (typeof record.status === "string") return { ...row, state: record.status, reason: record.reason ?? null };
  if (record.enabled === false) return { ...row, state: "disabled", reason: record.reason ?? null };
  if (!record.lastRunAt) return { ...row, state: "not-recorded", reason: "No run recorded on this runtime" };
  return { ...row, state: row.consecutiveFailures > 0 ? "failing" : "ok", reason: record.reason ?? null };
}

function claimPrsTile(record) {
  const skipped = record?.lastSummary?.skippedInvalid;
  if (Number.isFinite(skipped)) {
    return { state: "recorded", skippedInvalid: skipped, at: epoch(record.lastSummaryAt) };
  }
  return {
    state: "not-recorded",
    skippedInvalid: null,
    at: epoch(record?.lastSummaryAt),
    reason: "The last claim-prs summary available to this runtime does not carry a skipped-row count"
  };
}

function readRow(store, sql, params = []) {
  if (!store?.db?.prepare) return null;
  try { return store.db.prepare(sql).get(...params) ?? null; }
  catch { return null; }
}

function integrityTile(store, integrityRecord) {
  const cursor = readRow(store, "SELECT step, sweep_after FROM integrity_job_cursor WHERE singleton=1");
  const snapshot = readRow(store, "SELECT verified_at FROM integrity_snapshot WHERE id=1");
  const stepIndex = Number.isInteger(cursor?.step) && cursor.step >= 0 && cursor.step < INTEGRITY_STEP_NAMES.length
    ? cursor.step : null;
  // Present only once the batch-isolation store (#3544) has landed; the
  // guarded read keeps this tile honest on either side of that merge.
  const failure = readRow(store, `SELECT step, record_id, code, failures, first_seen_at, last_seen_at
    FROM integrity_failures ORDER BY last_seen_at DESC, step ASC LIMIT 1`);
  const outstanding = failure
    ? readRow(store, "SELECT COUNT(*) AS n FROM integrity_failures")?.n ?? null
    : null;
  const mostRecentFailure = failure ? {
    step: failure.step,
    recordId: failure.record_id || null,
    code: failure.code || null,
    failures: failure.failures ?? null,
    firstSeenAt: iso(failure.first_seen_at),
    lastSeenAt: iso(failure.last_seen_at)
  } : null;
  const lastFailingRoom = mostRecentFailure && ROOM_RECORD_STEPS.has(mostRecentFailure.step)
    ? mostRecentFailure.recordId : null;
  return {
    state: mostRecentFailure ? "failing" : (cursor || snapshot) ? "recorded" : "not-recorded",
    cursor: stepIndex === null ? null : {
      nextStepIndex: stepIndex,
      nextStepName: INTEGRITY_STEP_NAMES[stepIndex],
      stepsTotal: INTEGRITY_STEP_NAMES.length,
      sweepAfter: cursor.sweep_after || null
    },
    snapshot: { verifiedAt: snapshot?.verified_at ?? null },
    lastJobFailure: integrityRecord ? {
      code: integrityRecord.lastErrorCode ?? integrityRecord.lastFailure?.code ?? null,
      subcheck: integrityRecord.lastErrorSubcheck ?? integrityRecord.lastFailure?.subcheck ?? null,
      errorClass: integrityRecord.lastErrorClass ?? integrityRecord.lastFailure?.errorClass ?? null,
      recordClass: integrityRecord.lastErrorRecordClass ?? integrityRecord.lastFailure?.recordClass ?? null,
      at: epoch(integrityRecord.lastErrorAt),
      consecutiveFailures: integrityRecord.consecutiveFailures ?? 0
    } : null,
    outstandingFailures: outstanding,
    mostRecentFailure,
    lastFailingRoom,
    lastFailingRoomState: mostRecentFailure
      ? (lastFailingRoom ? "recorded" : "not-room-scoped")
      : (failure === null && outstanding === null ? "not-recorded" : "none-failing")
  };
}

function boardTile(store) {
  try {
    const list = store?.publicWorkClaims?.list({ limit: 100 });
    if (!list || !Number.isFinite(list.claimableCount)) throw new Error("board unavailable");
    return {
      state: "recorded",
      claimableCount: list.claimableCount,
      tasksListed: Array.isArray(list.tasks) ? list.tasks.length : null,
      truncated: list.nextCursor != null
    };
  } catch {
    return { state: "not-recorded", claimableCount: null, tasksListed: null, truncated: null, reason: "Public board is not available on this store" };
  }
}

function backupTile(backup) {
  if (!backup || typeof backup !== "object") {
    return {
      state: "not-recorded", bytes: null, at: null, key: null, target: null,
      growthBytesPerDay: null, singleBodyCapBytes: null, marginDays: null,
      reason: "No backup measurement is available to this runtime (daily backups run on the Worker)"
    };
  }
  return { state: "recorded", ...backup };
}

function behaviourTile(store, now) {
  const windowStart = iso(now - SLI_WINDOW_DAYS * 86_400_000);
  // The one windowed behavioural measure the store supports today: the
  // escrow journal is an append-only, timestamped ledger, so lots that
  // reached the approved state inside the window can be counted without
  // deriving anything the records do not say.
  const settled = readRow(store,
    "SELECT COUNT(DISTINCT lot_id) AS lots FROM bounty_journal WHERE lot_state='approved' AND at >= ?",
    [windowStart]);
  const noBudget = "No SLO budget is defined in code or config, so no burn rate is computed";
  const sli = (id, fields) => ({
    id, observedRate: null, budget: null, burnRate: null, burnState: burnState(null), ...fields
  });
  return {
    windowDays: SLI_WINDOW_DAYS,
    windowStart,
    windowEnd: iso(now),
    slis: [
      sli("task-success", {
        state: "not-recorded", observed: null,
        gap: "Reviews mutate claim state in place; there is no decided-outcome ledger (claim, decision, decided_at), so a windowed success rate cannot be computed"
      }),
      sli("tool-accuracy", {
        state: "not-recorded", observed: null,
        gap: "No tool-call outcome telemetry is recorded; agent tool calls leave no per-call success/failure ledger to measure accuracy from"
      }),
      sli("cost-per-task", {
        state: settled ? "recorded" : "not-recorded",
        observed: settled ? { approvedLots: settled.lots ?? 0, windowDays: SLI_WINDOW_DAYS } : null,
        gap: settled
          ? `${noBudget}. Journal legs are movements, not prices, so credits per settled lot is not derived`
          : "The escrow journal is not readable on this store"
      }),
      sli("policy-compliance", {
        state: "not-recorded", observed: null,
        gap: "No policy-violation or adjudication ledger exists; quarantine splits are structural thread operations, not violations, and carry no denominator"
      })
    ]
  };
}

// Inputs are resolved facts, not promises: `jobs` is { source, jobs } (or a
// bare array, or null when no runtime record exists), `backup` is the latest
// backup measurement object or null, and `workerDoorRevision` is the
// revision string read from the Worker door, or null when that read failed.
export function buildStatusSurface({ store = null, jobs = null, backup = null, workerDoorRevision = null,
  origin = null, deployment = null, now = Date.now() } = {}) {
  const jobList = Array.isArray(jobs) ? jobs : Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  const jobSource = Array.isArray(jobs) ? "runtime-records" : (typeof jobs?.source === "string" ? jobs.source : "none");
  const byName = new Map(jobList.map(record => [record?.name, record]));
  const doorsMatch = typeof workerDoorRevision === "string"
    ? revisionDrift(SOURCE_REVISION, workerDoorRevision).match : null;
  return {
    schema: STATUS_SURFACE_SCHEMA,
    generatedAt: iso(now),
    deployment: {
      origin,
      deployment,
      sourceRevision: SOURCE_REVISION,
      buildId: BUILD_ID,
      doors: {
        do: SOURCE_REVISION,
        worker: workerDoorRevision,
        state: workerDoorRevision === null ? "unknown" : doorsMatch ? "converged" : "diverged",
        checkedAt: iso(now)
      }
    },
    jobs: { source: jobSource, rows: JOBS.map(job => jobRow(job, byName.get(job.name))) },
    integrity: integrityTile(store, byName.get("integrity")),
    claimPrs: claimPrsTile(byName.get("claim-prs")),
    backup: backupTile(backup),
    board: boardTile(store),
    behaviour: behaviourTile(store, now)
  };
}

// Resolves the runtime providers, then builds. Providers are injected by
// the host process: the Durable Object passes its heartbeat read and the
// backup-binding measurement; a Node process falls back to its scheduler
// records and records the backup tile as not-recorded, because the daily
// backup runs on the Worker only.
export async function collectStatusSurface({ store = null, providers = {}, now = Date.now() } = {}) {
  let jobs = null;
  if (typeof providers.jobHealth === "function") {
    const provided = await providers.jobHealth();
    if (Array.isArray(provided)) jobs = { source: providers.jobHealthSource ?? "runtime-records", jobs: provided };
    else if (provided && Array.isArray(provided.jobs)) {
      jobs = { source: provided.source ?? providers.jobHealthSource ?? "runtime-records", jobs: provided.jobs };
    }
  } else {
    const records = nodeJobHealth();
    jobs = records ? { source: "node-scheduler", jobs: records } : null;
  }
  const backup = typeof providers.backupStatus === "function" ? await providers.backupStatus() : null;
  const workerDoorRevision = typeof providers.workerDoorRevision === "function"
    ? await providers.workerDoorRevision()
    : await readWorkerDoorRevision(providers.origin ?? null);
  return buildStatusSurface({
    store, jobs, backup, workerDoorRevision,
    origin: providers.origin ?? null,
    deployment: providers.deployment ?? null,
    now
  });
}
