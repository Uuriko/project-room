// A job that has been failing for a long stretch keeps its own status.
// It does not decide /api/health/jobs. Integrity has been failing
// messages_parity since 2026-10-11 (hundreds of consecutive failures,
// lastErrorCurrent still true). That mismatch is a live record, not an
// obsolete checker, so the job stays enabled and reports failing. The
// rollup ignores it once the streak is both long and old, and the worst
// remaining enabled job — including a stale minute cron — is the status.

const LONG_FAIL_MS = 6 * 60 * 60 * 1000;
const LONG_FAIL_COUNT = 24;

function failureAgeMs(job, now) {
  const successAt = Date.parse(job?.lastSuccessAt ?? "");
  if (Number.isFinite(successAt)) return Math.max(0, now - successAt);
  const periods = Number(job?.consecutiveFailures) * Number(job?.periodSeconds) * 1000;
  return Number.isFinite(periods) ? periods : 0;
}

export function jobIsQuarantined(job, now = Date.now()) {
  if (!job || job.required === true || job.status !== "failing") return false;
  if ((job.consecutiveFailures ?? 0) < LONG_FAIL_COUNT) return false;
  return failureAgeMs(job, now) >= LONG_FAIL_MS;
}

// Recompute the rollup only when a job is quarantined. A view with no
// long-failing job keeps the status its caller already set.
export function jobHealthSignal(view, now = Date.now()) {
  if (!view || view.status === "unavailable" || !Array.isArray(view.jobs)) return view;
  const at = Number.isFinite(Date.parse(view.generatedAt ?? "")) ? Date.parse(view.generatedAt) : now;
  let quarantined = false;
  const jobs = view.jobs.map(job => {
    if (!jobIsQuarantined(job, at)) return job;
    quarantined = true;
    return { ...job, quarantined: true };
  });
  if (!quarantined) return view;
  const counted = jobs.filter(job => job.status !== "disabled" && job.quarantined !== true);
  const requiredDisabled = jobs.some(job => job.status === "disabled" && job.required);
  const status = counted.some(job => job.stale || job.status === "stale") ? "stale"
    : requiredDisabled || counted.some(job => job.status === "failing") ? "failing"
    : counted.some(job => job.status === "degraded" || job.degraded) ? "degraded"
    : "ok";
  return { ...view, status, jobs };
}
