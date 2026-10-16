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

import { JOBS, nodeJobHealth } from "./jobs.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { revisionDrift } from "./operator-status.mjs";

export const STATUS_SURFACE_SCHEMA = "room.operator-status/1";

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

// Inputs are resolved facts, not promises: `jobs` is { source, jobs } (or a
// bare array, or null when no runtime record exists) and
// `workerDoorRevision` is the revision string read from the Worker door, or
// null when that read failed.
export function buildStatusSurface({ jobs = null, workerDoorRevision = null,
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
    claimPrs: claimPrsTile(byName.get("claim-prs"))
  };
}

// Resolves the runtime providers, then builds. Providers are injected by
// the host process: the Durable Object passes its heartbeat read; a Node
// process falls back to its scheduler records.
export async function collectStatusSurface({ providers = {}, now = Date.now() } = {}) {
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
  const workerDoorRevision = typeof providers.workerDoorRevision === "function"
    ? await providers.workerDoorRevision()
    : await readWorkerDoorRevision(providers.origin ?? null);
  return buildStatusSurface({
    jobs, workerDoorRevision,
    origin: providers.origin ?? null,
    deployment: providers.deployment ?? null,
    now
  });
}
