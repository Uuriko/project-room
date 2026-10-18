import { JOBS as REGISTRY, JOB_BUDGET_MS, jobDisabledReason, jobEnabled, jobNextDue } from "../server/jobs.mjs";
import { escrowKeeperHealth } from "../server/bounty-epoch-keeper.mjs";

// Per-job cron heartbeat. Every scheduled job records lastRunAt, lastSuccessAt
// and a redacted lastError in the Durable Object, and GET /api/health/jobs reads
// it back without auth. A job whose lastSuccessAt is older than 3x its period is
// stale. A disabled job is not stale. This is the signal that was missing when
// every cron tick failed with a DO RPC error for weeks while page health checks
// stayed green.

export const HEARTBEAT_STORAGE_KEY = 'cron:job-heartbeats:v1';
export const STALE_PERIODS = 3;
// A cron RPC shares the request Durable Object. Each job gets this long,
// then it stops at the next item so a slow tick cannot pin the input gate.
// One budget for both runtimes (#3767): the value lives in the registry
// module and this name — kept for the cron call sites — derives from it,
// so the two can never drift apart.
export const CRON_JOB_BUDGET_MS = JOB_BUDGET_MS;

// Worker jobs, in registry order. The safety-net cron is every 30 minutes;
// due work runs from the Durable Object alarm instead.
export const CRON_JOBS = Object.freeze(REGISTRY.filter(job => job.runtimes.includes("worker")).map(job => Object.freeze({
  name: job.name,
  periodSeconds: Math.round(job.cadenceMs / 1000),
  redactErrors: job.redactErrors === true,
  required: job.required === true
})));
const JOBS = new Map(CRON_JOBS.map(job => [job.name, job]));

export function selectWorkerJobs(env, store) {
  return REGISTRY.filter(job => job.runtimes.includes("worker") && jobEnabled(job, env, store));
}

// Kept for callers that still ask by name. The registry gate is the source.
export function cronIntegrationConfigured(name, env = {}, store = null) {
  const job = REGISTRY.find(item => item.name === name);
  if (!job) return false;
  return jobEnabled(job, env, store);
}
const MAX_ERROR = 240;
const MAX_SUMMARY_KEYS = 12;

// Error text can quote URLs, headers or tokens. Keep one short line and drop
// anything that looks like a credential or a query string.
export function redactError(value) {
  const text = String(value ?? 'unknown error')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(bearer|token|secret|password|authorization)(\s*[:=]?\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\b(?:pri|ghp|gho|ghs|ghu|github_pat|sk|xox[abpr]|whsec|re)_[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]')
    .trim();
  return text.length > MAX_ERROR ? text.slice(0, MAX_ERROR - 1) + '…' : text;
}

function errorText(job, error) {
  if (job?.redactErrors) {
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(error.code) ? error.code : null;
    return code ?? `${job.name} tick failed`;
  }
  return redactError(error?.message ?? error);
}

// A job can resolve and still report a failure in its summary (the channel
// drainer never throws; it returns scanError / errors instead).
export function summaryFailure(result) {
  if (!result || typeof result !== 'object') return null;
  // budgetExceeded is cooperative progress, recorded in the summary. It is
  // not a failed tick: the next minute continues the remainder.
  if (result.scanError) return `scanError: ${redactError(result.scanError)}`;
  if (Number(result.errors) > 0) return `${Number(result.errors)} error(s) in tick`;
  return null;
}

const DETAIL_CODE = /^[a-z][a-z0-9_]{0,63}$/i;
const DETAIL_TOKEN = /^[a-z][a-z0-9_]{0,40}$/i;
const DETAIL_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// A job may attach a sanitized failure detail (stable codes and classes
// only, e.g. the integrity job's failing sub-check — #3334). Every field
// must be a short token, so no body or secret can ride this channel onto
// the public health surface. The integrity job may attach the failing
// ROOM (recordId) for its room-record steps to the stored failure detail
// — operators read it from the job detail and the token-gated operator
// status — but jobHealthView deliberately does not project it: the
// public health view must not carry block evidence for a room
// (integrity-block-health), not even its id. The shape check below still
// bars everything that is not id-shaped.
export function sanitizeFailureDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  if (typeof detail.code === "string" && DETAIL_CODE.test(detail.code)) out.code = detail.code;
  for (const key of ["subcheck", "errorClass", "recordClass"]) {
    if (typeof detail[key] === "string" && DETAIL_TOKEN.test(detail[key])) out[key] = detail[key];
  }
  if (typeof detail.recordId === "string" && DETAIL_RECORD_ID.test(detail.recordId)) out.recordId = detail.recordId;
  return Object.keys(out).length ? out : null;
}

// Numbers and booleans only: summaries must never carry ids, bodies or secrets.
export function compactSummary(result) {
  if (!result || typeof result !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (Object.keys(out).length >= MAX_SUMMARY_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// One job at a time. Promise.all queued every RPC onto the Durable Object
// before any of them yielded, so a request that arrived mid-tick waited for
// the whole set. A turn yield between jobs lets the Worker deliver HTTP
// before the next RPC. Never rejects. One outcome per job.
export async function runCronJobs(runners, {
  now = () => Date.now(),
  log = (...args) => console.warn(...args),
  yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0))
} = {}) {
  const entries = Object.entries(runners);
  const outcomes = [];
  for (let index = 0; index < entries.length; index++) {
    if (index > 0) await yieldTurn();
    const [name, run] = entries[index];
    const job = JOBS.get(name) ?? { name, periodSeconds: 60 };
    const startedAt = now();
    try {
      const result = await run();
      const failure = summaryFailure(result);
      const durationMs = now() - startedAt;
      console.info(JSON.stringify({ event: 'room.cron_job', job: name, ok: !failure, durationMs }));
      if (failure) log(`[${name}] cron tick reported failure: ${failure}`);
      // A result may declare itself unobserved (#3927 R2): the tick ran
      // but saw nothing that grades the job's health — the channel drain
      // starting a background drain, or finding one still inflight, with
      // no completed outcome consumed. Only the drain declares it today;
      // no other job's result carries the field.
      const unobserved = !failure && (result?.unobserved === 1 || result?.unobserved === true);
      outcomes.push({ job: name, ok: !failure, at: startedAt, durationMs, error: failure, summary: compactSummary(result), failure: failure ? sanitizeFailureDetail(result?.failureDetail) : null,
        ...(unobserved ? { unobserved: true } : {}) });
    } catch (error) {
      const message = errorText(job, error);
      const durationMs = now() - startedAt;
      console.info(JSON.stringify({ event: 'room.cron_job', job: name, ok: false, durationMs }));
      log(`[${name}] cron tick failed: ${message}`);
      outcomes.push({ job: name, ok: false, at: startedAt, durationMs, error: message, summary: null, failure: sanitizeFailureDetail(error?.failureDetail) });
    }
  }
  return outcomes;
}

// Folds one tick's outcomes into the stored per-job record.
export function applyOutcomes(previous, outcomes) {
  const next = { ...(previous && typeof previous === 'object' ? previous : {}) };
  for (const outcome of outcomes ?? []) {
    if (!outcome || !JOBS.has(outcome.job)) continue;
    const prior = next[outcome.job] ?? {};
    const at = Number.isFinite(outcome.at) ? outcome.at : Date.now();
    // An unobserved success (#3927 R2) records the run — lastRunAt, the
    // summary, the duration — and nothing else: it carries no evidence
    // about the job's health, so it must neither erase a recorded
    // failure (consecutiveFailures, lastError, lastFailure all stand)
    // nor advance the success clock (lastSuccessAt). Only an outcome
    // that observed the work itself may do either.
    // A failing tick that returned a result carries that tick's own summary
    // (numbers/booleans only, via compactSummary). Persist it — with its own
    // lastSummaryAt — instead of leaving the last successful tick's summary
    // on the surface for as long as the job keeps failing. Dropping it hid
    // #3855's blockedRooms count in production: the integrity job merges
    // the standing count into its result on failing ticks too, but while
    // an unrelated sub-check (agent_connections) kept every tick failing,
    // the surface kept serving a pre-#3855 success summary that has no
    // blockedRooms key at all. A tick that threw carries no summary
    // (runCronJobs records null); then the prior summary stands, still
    // labelled by its own lastSummaryAt.
    const failureSummary = outcome.ok ? null : compactSummary(outcome.summary);
    next[outcome.job] = outcome.ok
      ? outcome.unobserved
        ? { ...prior, lastRunAt: at, lastDurationMs: outcome.durationMs ?? null, lastSummary: compactSummary(outcome.summary), lastSummaryAt: at }
        : { ...prior, lastRunAt: at, lastSuccessAt: at, consecutiveFailures: 0, lastDurationMs: outcome.durationMs ?? null, lastSummary: compactSummary(outcome.summary), lastSummaryAt: at, lastFailure: null }
      : { ...prior, lastRunAt: at, lastErrorAt: at, lastError: redactError(outcome.error), consecutiveFailures: (prior.consecutiveFailures ?? 0) + 1,
        lastDurationMs: outcome.durationMs ?? null, lastFailure: sanitizeFailureDetail(outcome.failure),
        ...(failureSummary ? { lastSummary: failureSummary, lastSummaryAt: at } : {}) };
  }
  return next;
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Public read model. Stale = no success within STALE_PERIODS periods.
// A disabled job is listed with a reason and is not stale — except a
// required job (registry `required`), whose disable is a configuration
// failure and fails the rollup below. Gates stay unknown
// when both env and store are omitted, so a stored heartbeat can still be read.
export function jobHealthView(stored, now = Date.now(), env = null, store = null) {
  const gatesKnown = env != null || store != null;
  const jobs = CRON_JOBS.map(job => {
    const record = stored?.[job.name] ?? {};
    const staleAfterSeconds = job.periodSeconds * STALE_PERIODS;
    const source = REGISTRY.find(item => item.name === job.name);
    const enabled = !gatesKnown || (source ? jobEnabled(source, env ?? {}, store) : true);
    const reason = enabled || !source ? null : jobDisabledReason(source, env ?? {}, store);
    const next = enabled && source && store ? jobNextDue(source, store, now, record.lastRunAt) : null;
    const waiting = Number.isFinite(next) && next > now;
    const ageSeconds = Number.isFinite(record.lastSuccessAt) ? Math.max(0, Math.round((now - record.lastSuccessAt) / 1000)) : null;
    const stale = enabled && !waiting && (ageSeconds === null || ageSeconds > staleAfterSeconds);
    const failing = enabled && (record.consecutiveFailures ?? 0) > 0;
    // A tick that succeeded but was held by GitHub's rate limit did no work.
    // Show it, without turning a recoverable wait into a 503.
    const degraded = enabled && !stale && !failing && record.lastSummary?.rateLimited === true ? 'github_rate_limited' : null;
    return {
      name: job.name,
      periodSeconds: job.periodSeconds,
      staleAfterSeconds,
      lastRunAt: iso(record.lastRunAt),
      lastSuccessAt: iso(record.lastSuccessAt),
      secondsSinceSuccess: enabled ? ageSeconds : null,
      lastError: record.lastError ?? null,
      lastErrorAt: iso(record.lastErrorAt),
      // A success keeps lastError/lastErrorAt as history (applyOutcomes), so
      // the text alone cannot say whether it is today's failure. On
      // 2026-10-17 claim-prs read degraded (github_rate_limited) beside a
      // lastError from 2026-10-15 and was triaged as a live validation
      // failure. lastErrorCurrent is true only while the job is failing now.
      lastErrorCurrent: record.lastError != null && (record.consecutiveFailures ?? 0) > 0,
      lastErrorCode: record.lastFailure?.code ?? null,
      lastErrorSubcheck: record.lastFailure?.subcheck ?? null,
      lastErrorClass: record.lastFailure?.errorClass ?? null,
      lastErrorRecordClass: record.lastFailure?.recordClass ?? null,
      lastDurationMs: record.lastDurationMs ?? null,
      consecutiveFailures: record.consecutiveFailures ?? 0,
      lastSummary: record.lastSummary ?? null,
      lastSummaryAt: iso(record.lastSummaryAt),
      required: job.required === true,
      stale,
      degraded,
      reason,
      status: !enabled ? 'disabled' : stale ? 'stale' : failing ? 'failing' : degraded ? 'degraded' : 'ok',
      // The escrow keeper's kill flag (state + since-timestamps, room
      // counts only — no room ids on this public surface), read live
      // from the store when the caller supplied one, so a deliberate
      // halt is observable here instead of silent. Attached even when
      // the job is disabled for lack of due work: the flag outlives
      // the queue. A killed job that keeps ticking successfully still
      // reads 'ok' above — the halt is a state, not a failure.
      ...(job.name === 'escrow-epochs' && store ? { keeperKill: escrowKeeperHealth(store) } : {})
    };
  });
  const active = jobs.filter(job => job.status !== 'disabled');
  // #3894: a required job (room-backup) disabled by a dropped binding is
  // a configuration failure, not healthy idle: the deployment cannot do
  // the safety work at all, and "disabled" is also what an intentional
  // disable looks like. It fails the rollup while keeping its honest
  // per-job 'disabled' status and reason. Ordinary disabled jobs
  // (work-gated, feature-gated) stay out of the rollup as before.
  const requiredDisabled = jobs.some(job => job.status === 'disabled' && job.required);
  const status = active.some(job => job.stale) ? 'stale' : requiredDisabled || active.some(job => job.status === 'failing') ? 'failing'
    : active.some(job => job.status === 'degraded') ? 'degraded' : 'ok';
  return { schema: 'room.job-health/1', status, generatedAt: iso(now), staleAfterPeriods: STALE_PERIODS, jobs };
}

export function jobHealthResponse(view, { head = false } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  return new Response(head ? null : JSON.stringify(view), { status: view?.status === 'ok' || view?.status === 'degraded' ? 200 : 503, headers });
}

export function jobHealthUnavailable({ head = false } = {}) {
  return jobHealthResponse({ schema: 'room.job-health/1', status: 'unavailable', generatedAt: iso(Date.now()), jobs: [] }, { head });
}
