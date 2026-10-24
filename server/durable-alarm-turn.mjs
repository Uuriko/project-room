// Request path: enqueue due jobs and return. Alarm path: run one slice.
// Slow jobs are enqueued only when the caller asks (the safety-net cron).
// Fast jobs are enqueued whenever this turn runs, which is also the alarm.

import { JOBS, jobEnabled, jobIsDue } from "./jobs.mjs";
import { enqueueDurableAlarm, nextDurableAlarmAt, runDurableAlarmSlice } from "./durable-alarm-queue.mjs";

export function durableAlarmQueueEnabled(env) {
  return env?.ROOM_DURABLE_ALARM_QUEUE === "1";
}

const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function enqueueDueWorkerJobs(db, { env, store, now, lastRan, includeSlow = false }) {
  const queued = [];
  for (const job of JOBS) {
    if (!job.runtimes.includes("worker") || !JOB_NAME.test(job.name)) continue;
    if (job.slow && !includeSlow) continue;
    if (!jobEnabled(job, env, store) || !jobIsDue(job, store, now, lastRan?.[job.name])) continue;
    const slot = Math.floor(now / job.cadenceMs);
    const row = enqueueDurableAlarm(db, {
      dedupeKey: `job:${job.name}:${slot}`,
      kind: job.slow ? "slow-job" : "fast-job",
      payload: { name: job.name },
      runAt: now
    }, now);
    if (row.created) queued.push(job.name);
  }
  return queued;
}

export async function runDurableAlarmTurn({
  db, env, store, now, lastRan, includeSlow = false, drain = false, runJob
}) {
  if (!durableAlarmQueueEnabled(env)) return { enabled: false };
  const queued = enqueueDueWorkerJobs(db, { env, store, now, lastRan, includeSlow });
  if (!drain) return { enabled: true, drained: false, queued, nextAt: nextDurableAlarmAt(db) };
  if (typeof runJob !== "function") throw new TypeError("durable alarm drain needs runJob");
  const slice = await runDurableAlarmSlice({
    db, now,
    run: async item => {
      // Unknown kinds fail closed. A later flag may handle its own kind
      // before this check; a row we do not understand is retried, then poisoned.
      if ((item.kind !== "fast-job" && item.kind !== "slow-job") || !JOB_NAME.test(item.payload?.name ?? "")) {
        return { ok: false };
      }
      const outcomes = await runJob(item.payload.name, item.kind === "slow-job");
      const ok = Array.isArray(outcomes) && outcomes.every(outcome => outcome?.ok !== false);
      return { ok, outcomes };
    }
  });
  if (slice.ran || slice.recovered || slice.skipped) {
    console.info(JSON.stringify({
      event: "room.alarm_queue",
      recovered: slice.recovered,
      ran: slice.ran ? 1 : 0,
      kind: slice.item?.kind ?? null,
      attempt: slice.item?.attempt ?? 0
    }));
  }
  return { enabled: true, drained: true, queued, ...slice };
}
