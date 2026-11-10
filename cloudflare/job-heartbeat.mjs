import { JOBS as REGISTRY, JOB_BUDGET_MS, jobDisabledReason, jobEnabled, jobNextDue } from "../server/jobs.mjs";

// Per-job cron heartbeat. Every scheduled job records lastRunAt, lastSuccessAt
// and a redacted lastError in the Durable Object. GET /api/health/jobs exposes
// a fixed error marker and structured run facts without auth, never error prose.
// A job whose lastSuccessAt is older than 3x its period is
// stale. A disabled job is not stale. This is the signal that was missing when
// every cron tick failed with a DO RPC error for weeks while page health checks
// stayed green.

export const HEARTBEAT_STORAGE_KEY = 'cron:job-heartbeats:v1';
export const STALE_PERIODS = 3;
// Guardian census F1 (2026-10-18): a job summary can carry work its own
// pass left unactioned (escrow-epochs' `overdue`). One tick's count can
// be a clock race — a bounty that came due mid-pass is next tick's work.
// Sustained across OVERDUE_DEGRADE_TICKS consecutive observed ticks,
// each a full pass that still could not act, it is a stall: the health
// view grades the job degraded (reason 'escrow_overdue') and exposes the
// streak + its start so the stall has an age on the surface instead of
// riding invisibly inside a numeric summary on an 'ok' job.
export const OVERDUE_DEGRADE_TICKS = 3;
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
  periodSeconds: Math.round((job.heartbeatCadenceMs ?? job.cadenceMs) / 1000),
  redactErrors: job.redactErrors === true,
  required: job.required === true
})));
const JOBS = new Map(CRON_JOBS.map(job => [job.name, job]));

export function selectWorkerJobs(env, store, { onlyJob = null, includeSlow = true } = {}) {
  return REGISTRY.filter(job => {
    if (!job.runtimes.includes("worker")) return false;
    if (onlyJob !== null && job.name !== onlyJob) return false;
    if (!includeSlow && job.slow) return false;
    // A throwing due probe (B8-4/B8-5) excludes only its own job this
    // pass — jobEnabled already logged it, and the health view renders
    // that job failing — instead of failing the whole selection.
    try { return jobEnabled(job, env, store); }
    catch { return false; }
  });
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
// anything that looks like a credential or a query string. The pattern set
// is pinned to the Node scheduler's copy (redactJobError in server/jobs.mjs)
// by tests/job-health-redaction.test.js: both health surfaces are read back
// unauthenticated, so the two copies must never drift apart.
export function redactError(value) {
  const text = String(value ?? 'unknown error')
    // A credential split across a line break is two short runs, neither of
    // which trips the long-run rule below. Join token runs separated by a
    // real newline or a JSON-escaped \n when both sides look like token
    // material, so the joined run is judged as one credential.
    .replace(/([A-Za-z0-9+/_=-]{8,})(?:\r\n|\n|\\n)([A-Za-z0-9+/_=-]{8,})/g, '$1$2')
    .replace(/[\r\n\t]+/g, ' ')
    // PEM blocks: the key body is base64 lines whose individual runs can
    // sit under the long-run threshold (a GCP service-account key body
    // leaked this way). Take the whole block, and fail closed on an
    // unterminated BEGIN marker.
    .replace(/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*-----/g, '[redacted]')
    .replace(/-----BEGIN [A-Z0-9 ]*-----[\s\S]*/g, '[redacted]')
    // URI/URL userinfo (mongodb://user:password@host, redis://:password@,
    // amqp://, mysql://, https://user:password@): the password sits before
    // the @, ahead of any query string, so the query-strip below never
    // reaches it. Short passwords between delimiters also slip past the
    // long-run rule, which is how the DB URI passwords leaked.
    .replace(/(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+(@)/g, '$1[redacted]$2')
    // Compound key names — my_password_value, passwordHash, client_secret,
    // private_key, AccountKey=: the credential word may be prefixed or
    // suffixed, which a bare \b keyword match misses. The value needs a
    // real assignment separator and at least 8 chars, so this rule does
    // not extend the legacy keyword rule's reach to short tails.
    .replace(/([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|account[-_]?key|credential)[A-Za-z0-9_-]*)(\s*"?\s*[:=]\s*"?)([^\s"',;}]{8,})/gi, '$1$2[redacted]')
    .replace(/\b(bearer|token|secret|password|authorization)(\s*[:=]?\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\b(?:(?:pri|ghp|gho|ghs|ghu|github_pat|sk|xox[abpr]|whsec|re)_|glpat-|pypi-|dckr_pat_)[A-Za-z0-9_-]{6,}/g, '[redacted]')
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
  for (const key of ["subcheck", "errorClass", "recordClass", "reason", "component"]) {
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
    if ((key === "blockReason" || key === "blockComponent") && typeof value === "string" && DETAIL_TOKEN.test(value)) {
      out[key] = value;
      continue;
    }
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
    // Chronology guard (inherited defect, reproduced by Codex at main
    // c1c92c5b): the fold is monotonic. An outcome OLDER than the
    // recorded state (at < lastRunAt) is stale — a late completion
    // landing after a newer outcome already folded — and must not
    // rewind that state: folding it in array order moved lastRunAt
    // backward and let an older success reset consecutiveFailures to
    // 0, presenting a failing job as freshly succeeded. A stale
    // outcome therefore folds nothing; its exact-ID attempt
    // resolution below still runs, so the attempt-ID cure's handling
    // is unchanged. An outcome at exactly lastRunAt is not stale and
    // keeps the pre-existing fold semantics.
    const stale = Number.isFinite(prior.lastRunAt) && at < prior.lastRunAt;
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
    const folded = outcome.ok
      ? outcome.unobserved
        ? { ...prior, lastRunAt: at, lastDurationMs: outcome.durationMs ?? null, lastSummary: compactSummary(outcome.summary), lastSummaryAt: at }
        : { ...prior, lastRunAt: at, lastSuccessAt: at, consecutiveFailures: 0, lastDurationMs: outcome.durationMs ?? null, lastSummary: compactSummary(outcome.summary), lastSummaryAt: at, lastFailure: null }
      : { ...prior, lastRunAt: at, lastErrorAt: at, lastError: redactError(outcome.error), consecutiveFailures: (prior.consecutiveFailures ?? 0) + 1,
        lastDurationMs: outcome.durationMs ?? null, lastFailure: sanitizeFailureDetail(outcome.failure),
        ...(failureSummary ? { lastSummary: failureSummary, lastSummaryAt: at } : {}) };
    const record = stale ? { ...prior } : folded;
    // A committed outcome resolves the attempt recorded before its run —
    // but ONLY on an exact attempt-ID match. The outcome fold is
    // serialized, not instantaneous: a slow job's completion can land
    // after the next pass has already committed a NEWER attempt, and
    // stamping that newer attempt 'committed' would erase the trace of
    // a run that may have died (Codex review of the attempt heartbeat,
    // 2026-11-01). A mismatched or unthreaded outcome leaves the
    // attempt fields exactly as they stand — lastAttemptAt keeps the
    // current attempt's start time — while its own run/success/failure
    // fields fold as they always have. Jobs that never carry an attempt
    // (attempts are committed for slow jobs only) gain no attempt
    // fields from their outcomes.
    if (typeof outcome.attemptId === 'string' && outcome.attemptId
      && prior.attemptOutcome === 'uncommitted' && prior.lastAttemptId === outcome.attemptId) {
      record.attemptOutcome = 'committed';
      record.uncommittedAttemptSinceAt = null;
    }
    // Overdue streak (guardian census F1): track consecutive observed
    // ticks whose summary reports overdue work, and when the current
    // streak began. Only a tick that actually carried a summary speaks:
    // a thrown tick (summary null) neither extends nor clears the
    // streak, and a job whose summary has no `overdue` field at all
    // (every job but escrow-epochs today) never gains one. A summary
    // with overdue: 0 closes the streak.
    const summary = stale ? null : outcome.ok ? record.lastSummary : failureSummary;
    if (summary && Number.isFinite(summary.overdue)) {
      if (summary.overdue > 0) {
        record.overdueStreak = (prior.overdueStreak ?? 0) + 1;
        record.overdueSinceAt = Number.isFinite(prior.overdueSinceAt) && (prior.overdueStreak ?? 0) > 0 ? prior.overdueSinceAt : at;
      } else {
        record.overdueStreak = 0;
        record.overdueSinceAt = null;
      }
    }
    next[outcome.job] = record;
  }
  return next;
}

// Attempt-before-run (integrity-staleness cure, part 1). #runDueJobsBody
// commits an attempt for a slow job BEFORE invoking it, folded through
// here. A run killed inside its own invocation (Durable Object reset,
// eviction, invocation limit) never reaches recordCronTick, so without
// the attempt the stored record keeps presenting the previous success
// as current until the 3x-period staleness line passes — the signature
// the integrity job showed from 2026-10-31T19:00:35Z. The attempt
// touches nothing else: lastRunAt, lastSuccessAt, consecutiveFailures,
// the error fields and the summaries all stand exactly as the last
// committed outcome left them. uncommittedAttemptSinceAt keeps the
// FIRST attempt of an unbroken uncommitted streak (the overdue-streak
// precedent above). Later attempts do not erase an unresolved completion;
// the view grades the streak's age, not the freshest stamp's. A missing
// outcome alone does not establish why execution failed to commit.
export function applyAttempts(previous, attempts) {
  const next = { ...(previous && typeof previous === 'object' ? previous : {}) };
  for (const attempt of attempts ?? []) {
    if (!attempt || !JOBS.has(attempt.job)) continue;
    const prior = next[attempt.job] ?? {};
    const at = Number.isFinite(attempt.at) ? attempt.at : Date.now();
    next[attempt.job] = {
      ...prior,
      lastAttemptAt: at,
      // The attempt's exact ID. Only the outcome carrying this same ID
      // may resolve the attempt (see applyOutcomes): a completion from
      // an older run landing after a newer attempt began must not erase
      // the newer attempt's trace. An attempt recorded without an ID
      // can never be resolved by an outcome — fail-closed.
      lastAttemptId: typeof attempt.attemptId === 'string' && attempt.attemptId ? attempt.attemptId : null,
      attemptOutcome: 'uncommitted',
      uncommittedAttemptSinceAt: prior.attemptOutcome === 'uncommitted' && Number.isFinite(prior.uncommittedAttemptSinceAt)
        ? prior.uncommittedAttemptSinceAt : at
    };
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
    // Rebuild structured public evidence even for predating stored records.
    const failure = sanitizeFailureDetail(record.lastFailure);
    const staleAfterSeconds = job.periodSeconds * STALE_PERIODS;
    const source = REGISTRY.find(item => item.name === job.name);
    // A throwing due probe (B8-4/B8-5) is a failure of this job's gate,
    // not a disable and not a pass: the entry renders failing with the
    // probe error as its reason, and the rest of the view still renders.
    let enabled = true;
    let reason = null;
    let next = null;
    let probeError = null;
    if (gatesKnown) {
      try {
        enabled = source ? jobEnabled(source, env ?? {}, store) : true;
        reason = enabled || !source ? null : jobDisabledReason(source, env ?? {}, store);
        next = enabled && source && store ? jobNextDue(source, store, now, record.lastRunAt) : null;
      } catch (error) {
        probeError = redactError(error?.message ?? error);
        enabled = true;
        reason = `Probe failed: ${probeError}`;
        next = null;
      }
    }
    // Work-gating stops idle delivery attempts, but cannot erase the last
    // terminal callback failure from health. Feature-off remains disabled.
    const idleNativeFailure = !enabled && job.name === 'native-mcp-events' && store?.nativeMcpEventsEnabled === true
      && (record.consecutiveFailures ?? 0) > 0 && (Number(record.lastSummary?.exhausted) > 0 || Number(record.lastSummary?.dead) > 0);
    if (idleNativeFailure) reason = 'Callback delivery failed; no pending deliveries';
    const waiting = Number.isFinite(next) && next > now;
    const ageSeconds = Number.isFinite(record.lastSuccessAt) ? Math.max(0, Math.round((now - record.lastSuccessAt) / 1000)) : null;
    let pendingSince = null;
    if (enabled && store && typeof source?.healthPendingSince === "function") {
      try { pendingSince = source.healthPendingSince(store, now); } catch { /* unknown remains fail-closed */ }
    }
    const recentPending = Number.isFinite(pendingSince) && pendingSince <= now
      && now - pendingSince <= staleAfterSeconds * 1000;
    const stale = enabled && !waiting && !recentPending && (ageSeconds === null || ageSeconds > staleAfterSeconds);
    // Unresolved completion (integrity-staleness cure, part 1): the latest
    // attempt has no committed outcome and the unbroken uncommitted
    // streak is older than one period. Its cause is unknown; the previous
    // success must not present as evidence of this attempt's completion.
    // A job with no attempt fields at all is never-attempted, a different state the fields below expose; the
    // ordinary stale rule alone grades it.
    const attemptStuck = enabled && record.attemptOutcome === 'uncommitted'
      && Number.isFinite(record.uncommittedAttemptSinceAt)
      && now - record.uncommittedAttemptSinceAt > job.periodSeconds * 1000;
    const failing = enabled && ((record.consecutiveFailures ?? 0) > 0 || attemptStuck || probeError !== null);
    // A tick that succeeded but was held by GitHub's rate limit did no work.
    // Show it, without turning a recoverable wait into a 503.
    // Escrow overdue (guardian census F1): the keeper's own pass left due
    // bounties unactioned for OVERDUE_DEGRADE_TICKS consecutive ticks.
    // That is a stall, not a wait — degrade so the surface (and anything
    // polling it) can see it; still not a 503: no tick has failed, the
    // work is late, and the streak fields below carry its age.
    const degraded = idleNativeFailure ? 'native_callback_failed' : enabled && !stale && !failing && record.lastSummary?.rateLimited === true ? 'github_rate_limited'
      : enabled && !stale && !failing && job.name === 'escrow-epochs' && (record.overdueStreak ?? 0) >= OVERDUE_DEGRADE_TICKS ? 'escrow_overdue' : null;
    return {
      name: job.name,
      periodSeconds: job.periodSeconds,
      staleAfterSeconds,
      ...(source?.healthPendingSince ? { pendingSinceAt: iso(pendingSince) } : {}),
      lastRunAt: iso(record.lastRunAt),
      lastSuccessAt: iso(record.lastSuccessAt),
      lastAttemptAt: iso(record.lastAttemptAt),
      attemptOutcome: typeof record.attemptOutcome === 'string' ? record.attemptOutcome : null,
      uncommittedAttemptSinceAt: iso(record.uncommittedAttemptSinceAt ?? null),
      secondsSinceSuccess: enabled ? ageSeconds : null,
      // Free-form diagnostics can contain unknown credentials or personal data.
      // Keep the public marker fixed, including for errors stored before this rule.
      // A probe failure is a failure fact: it earns the same fixed marker,
      // never the free-form probe text.
      lastError: record.lastError == null && probeError === null ? null : 'Job failed',
      lastErrorAt: iso(record.lastErrorAt),
      // A success keeps lastError/lastErrorAt as history (applyOutcomes), so
      // the text alone cannot say whether it is today's failure. On
      // 2026-10-17 claim-prs read degraded (github_rate_limited) beside a
      // lastError from 2026-10-15 and was triaged as a live validation
      // failure. lastErrorCurrent is true only while the job is failing now.
      lastErrorCurrent: record.lastError != null && (record.consecutiveFailures ?? 0) > 0,
      lastErrorCode: failure?.code ?? null,
      lastErrorSubcheck: failure?.subcheck ?? null,
      lastErrorClass: failure?.errorClass ?? null,
      lastErrorRecordClass: failure?.recordClass ?? null,
      lastErrorReason: failure?.reason ?? null,
      lastErrorComponent: failure?.component ?? null,
      lastDurationMs: record.lastDurationMs ?? null,
      consecutiveFailures: record.consecutiveFailures ?? 0,
      lastSummary: compactSummary(record.lastSummary),
      lastSummaryAt: iso(record.lastSummaryAt),
      overdueStreak: Number.isFinite(record.overdueStreak) ? record.overdueStreak : null,
      overdueSinceAt: iso(record.overdueSinceAt ?? null),
      required: job.required === true,
      stale,
      degraded,
      reason,
      status: idleNativeFailure ? 'degraded' : !enabled ? 'disabled' : probeError !== null ? 'failing' : stale ? 'stale' : failing ? 'failing' : degraded ? 'degraded' : 'ok'
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
