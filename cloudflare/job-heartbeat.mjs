// Per-job cron heartbeat. Every scheduled job records lastRunAt, lastSuccessAt
// and a redacted lastError in the Durable Object, and GET /api/health/jobs reads
// it back without auth. A job whose lastSuccessAt is older than 3x its period is
// stale. This is the signal that was missing when every cron tick failed with a
// DO RPC error for weeks while page health checks stayed green.

export const HEARTBEAT_STORAGE_KEY = 'cron:job-heartbeats:v1';
export const STALE_PERIODS = 3;

// The production trigger is "* * * * *" and each tick runs every job.
export const CRON_JOBS = Object.freeze([
  Object.freeze({ name: 'gmail-sync', periodSeconds: 60, redactErrors: true }),
  Object.freeze({ name: 'channel-drain', periodSeconds: 60 }),
  Object.freeze({ name: 'webhook-dispatch', periodSeconds: 60 }),
  Object.freeze({ name: 'land-queue', periodSeconds: 60 }),
  Object.freeze({ name: 'retention', periodSeconds: 60 })
]);
const JOBS = new Map(CRON_JOBS.map(job => [job.name, job]));
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

// Runs every job concurrently; never rejects. One outcome per job.
export async function runCronJobs(runners, { now = () => Date.now(), log = (...args) => console.warn(...args) } = {}) {
  return Promise.all(Object.entries(runners).map(async ([name, run]) => {
    const job = JOBS.get(name) ?? { name, periodSeconds: 60 };
    const startedAt = now();
    try {
      const result = await run();
      const failure = summaryFailure(result);
      if (failure) log(`[${name}] cron tick reported failure: ${failure}`);
      return { job: name, ok: !failure, at: startedAt, durationMs: now() - startedAt, error: failure, summary: compactSummary(result) };
    } catch (error) {
      const message = errorText(job, error);
      log(`[${name}] cron tick failed: ${message}`);
      return { job: name, ok: false, at: startedAt, durationMs: now() - startedAt, error: message, summary: null };
    }
  }));
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
export function jobHealthView(stored, now = Date.now()) {
  const jobs = CRON_JOBS.map(job => {
    const record = stored?.[job.name] ?? {};
    const staleAfterSeconds = job.periodSeconds * STALE_PERIODS;
    const ageSeconds = Number.isFinite(record.lastSuccessAt) ? Math.max(0, Math.round((now - record.lastSuccessAt) / 1000)) : null;
    const stale = ageSeconds === null || ageSeconds > staleAfterSeconds;
    const failing = (record.consecutiveFailures ?? 0) > 0;
    return {
      name: job.name,
      periodSeconds: job.periodSeconds,
      staleAfterSeconds,
      lastRunAt: iso(record.lastRunAt),
      lastSuccessAt: iso(record.lastSuccessAt),
      secondsSinceSuccess: ageSeconds,
      lastError: record.lastError ?? null,
      lastErrorAt: iso(record.lastErrorAt),
      consecutiveFailures: record.consecutiveFailures ?? 0,
      lastSummary: record.lastSummary ?? null,
      stale,
      status: stale ? 'stale' : failing ? 'failing' : 'ok'
    };
  });
  const status = jobs.some(job => job.stale) ? 'stale' : jobs.some(job => job.status === 'failing') ? 'failing' : 'ok';
  return { schema: 'room.job-health/1', status, generatedAt: iso(now), staleAfterPeriods: STALE_PERIODS, jobs };
}

export function jobHealthResponse(view, { head = false } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  return new Response(head ? null : JSON.stringify(view), { status: view?.status === 'ok' ? 200 : 503, headers });
}

export function jobHealthUnavailable({ head = false } = {}) {
  return jobHealthResponse({ schema: 'room.job-health/1', status: 'unavailable', generatedAt: iso(Date.now()), jobs: [] }, { head });
}
