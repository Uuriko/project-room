import { JOBS as REGISTRY, jobDisabledReason, jobEnabled, jobNextDue } from "../server/jobs.mjs";

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
export const CRON_JOB_BUDGET_MS = 5000;

// Worker jobs, in registry order. The safety-net cron is every 30 minutes;
// due work runs from the Durable Object alarm instead.
export const CRON_JOBS = Object.freeze(REGISTRY.filter(job => job.runtimes.includes("worker")).map(job => Object.freeze({
  name: job.name,
  periodSeconds: Math.round(job.cadenceMs / 1000),
  redactErrors: job.redactErrors === true
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
      outcomes.push({ job: name, ok: !failure, at: startedAt, durationMs, error: failure, summary: compactSummary(result) });
    } catch (error) {
      const message = errorText(job, error);
      const durationMs = now() - startedAt;
      console.info(JSON.stringify({ event: 'room.cron_job', job: name, ok: false, durationMs }));
      log(`[${name}] cron tick failed: ${message}`);
      outcomes.push({ job: name, ok: false, at: startedAt, durationMs, error: message, summary: null });
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
    next[outcome.job] = outcome.ok
      ? { ...prior, lastRunAt: at, lastSuccessAt: at, consecutiveFailures: 0, lastDurationMs: outcome.durationMs ?? null, lastSummary: compactSummary(outcome.summary) }
      : { ...prior, lastRunAt: at, lastErrorAt: at, lastError: redactError(outcome.error), consecutiveFailures: (prior.consecutiveFailures ?? 0) + 1,
        lastDurationMs: outcome.durationMs ?? null };
  }
  return next;
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Public read model. Stale = no success within STALE_PERIODS periods.
// A disabled job is listed with a reason and is not stale. Gates stay unknown
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
    return {
      name: job.name,
      periodSeconds: job.periodSeconds,
      staleAfterSeconds,
      lastRunAt: iso(record.lastRunAt),
      lastSuccessAt: iso(record.lastSuccessAt),
      secondsSinceSuccess: enabled ? ageSeconds : null,
      lastError: record.lastError ?? null,
      lastErrorAt: iso(record.lastErrorAt),
      consecutiveFailures: record.consecutiveFailures ?? 0,
      lastSummary: record.lastSummary ?? null,
      stale,
      reason,
      status: !enabled ? 'disabled' : stale ? 'stale' : failing ? 'failing' : 'ok'
    };
  });
  const active = jobs.filter(job => job.status !== 'disabled');
  const status = active.some(job => job.stale) ? 'stale' : active.some(job => job.status === 'failing') ? 'failing' : 'ok';
  return { schema: 'room.job-health/1', status, generatedAt: iso(now), staleAfterPeriods: STALE_PERIODS, jobs };
}

export function jobHealthResponse(view, { head = false } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  return new Response(head ? null : JSON.stringify(view), { status: view?.status === 'ok' ? 200 : 503, headers });
}

export function jobHealthUnavailable({ head = false } = {}) {
  return jobHealthResponse({ schema: 'room.job-health/1', status: 'unavailable', generatedAt: iso(Date.now()), jobs: [] }, { head });
}
