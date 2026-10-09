// Baseline: one 500-agent wave under CURRENT discipline (per-task room chatter).
// Counts room-log events only. Tuned to reproduce the measured ~6.5 events/lifecycle.
import { writeFileSync, mkdirSync } from 'node:fs';

const AGENTS = 500;
const EVENTS_PER_LIFECYCLE = 6.5; // measured
// Breakdown mapping of the 6.5: claim post + claim api event + heartbeats + progress + done
const breakdown = {
  claim_post: 1.0,
  claim_api_event: 0.5,   // not every claim emits a room-visible event
  heartbeats: 2.0,        // per-worker heartbeats per half-lease over a wave
  progress_posts: 2.0,
  done_post: 1.0,
}; // sums to 6.5

const conflictRate = 0.10, conflictExtra = 2;   // retry round-trip events
const deathRate = 0.05, orphanSweepEvents = 3;   // per-claim sweep: notice+release+reclaim post

const perTask = Object.values(breakdown).reduce((a, b) => a + b, 0);
const base = AGENTS * perTask;
const conflicts = AGENTS * conflictRate * conflictExtra;
const orphans = AGENTS * deathRate * orphanSweepEvents;
const total = Math.round(base + conflicts + orphans);

const result = {
  discipline: 'current (per-task room chatter)',
  agents: AGENTS,
  per_task_events: perTask,
  breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * AGENTS)])),
  conflict_retry_events: Math.round(conflicts),
  orphan_sweep_events: Math.round(orphans),
  total_room_events: total,
  lifetime_budget: 10000,
  budget_burned_pct: +(100 * total / 10000).toFixed(1),
  events_per_agent: +(total / AGENTS).toFixed(2),
  waves_until_budget_dead: +(10000 / total).toFixed(1),
};

mkdirSync('wave500-sim', { recursive: true });
writeFileSync('wave500-sim/baseline-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
