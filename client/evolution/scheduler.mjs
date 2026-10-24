import { setTimeout as delay } from 'node:timers/promises';
import { observe, policy, runJob } from './executor.mjs';
import { requireThat } from './store.mjs';

// App-owned local queue, not a second execution authority. runJob claims and
// reserves resources transactionally across every broker using this database.
export async function watchLocalCapabilities(store, { signal, intervalMs = 1000, emit = () => {}, observeResources = () => observe(store.directory) } = {}) {
  requireThat(Number.isInteger(intervalMs) && intervalMs >= 200 && intervalMs <= 60000, 'invalid_interval');
  const controller = new AbortController(), active = new Map();
  let after = 0, failure;
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    while (!controller.signal.aborted) {
      const p = policy(store);
      // Rotate past denied jobs; a blocked head must not hide runnable work.
      const rows = store.db.prepare("SELECT j.rowid,j.id FROM jobs j JOIN job_dispatch d ON d.job=j.id WHERE j.state='queued' AND d.source='local' AND j.rowid>? ORDER BY j.rowid LIMIT 64").all(after);
      if (!rows.length) after = 0;
      for (const row of rows) {
        if (controller.signal.aborted || active.size >= p.maxJobs) break;
        after = row.rowid;
        if (active.has(row.id)) continue;
        const work = runJob(store, row.id, { signal: controller.signal, observation: observeResources() })
          .then(result => {
            if (result.claimed) emit({ jobId: row.id, state: result.job.state, attempt: result.job.attempt, pin: result.job.pin });
          }).catch(error => { failure ??= error; stop(); }).finally(() => active.delete(row.id));
        active.set(row.id, work);
      }
      try { await delay(intervalMs, undefined, { signal: controller.signal }); }
      catch (error) { if (!controller.signal.aborted) throw error; }
    }
  } finally {
    stop();
    // The app may close its database only after every child has stopped and
    // written its final receipt. Never leave detached work behind on shutdown.
    await Promise.allSettled(active.values());
    signal?.removeEventListener('abort', stop);
  }
  if (failure) throw failure;
  return { stopped: true };
}

// Compact local-owner view. No job inputs, paths, logs or credentials. These are
// execution observations, not estimates of tokens avoided or work correctness.
export function executionMetrics(store) {
  const states = Object.fromEntries(store.db.prepare('SELECT state,count(*) AS count FROM jobs GROUP BY state').all().map(row => [row.state, row.count]));
  const steps = store.db.prepare(`SELECT count(*) AS recordedSteps,
    coalesce(sum(json_extract(receipt,'$.elapsedMs')),0) AS stepElapsedMs
    FROM steps WHERE receipt IS NOT NULL`).get();
  const artifacts = store.db.prepare(`SELECT coalesce(sum(json_array_length(result,'$.artifacts')),0) AS artifactCount,
    coalesce(sum(json_extract(result,'$.elapsedMs')),0) AS jobElapsedMs
    FROM jobs WHERE result IS NOT NULL`).get();
  return { schema: 1, states, ...steps, ...artifacts, modelCalls: 'not_instrumented', tokenSavings: 'not_measured',
    elapsedMeaning: 'sum_of_recorded_durations_not_wall_clock', physicalLimitsEnforced: false };
}
