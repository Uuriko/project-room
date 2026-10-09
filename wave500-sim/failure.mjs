// Failure: 50 of 500 agents die mid-wave. OLD vs NEW handling, in room events.
import { writeFileSync, mkdirSync } from 'node:fs';

const DEAD = 50;
// OLD: per-claim sweep-on-read + individual re-claims with room posts
const oldPerOrphan = 3;                    // sweep notice + release + re-claim post
const oldConflictRate = 0.30, oldConflictExtra = 2;
const oldTotal = Math.round(DEAD * oldPerOrphan + DEAD * oldConflictRate * oldConflictExtra);

// NEW: guild coordinator batch-release (1 event per affected guild), reaper = 0 events,
// survivors re-claim via ?fast=1 = 0 events, one recovery rollup per affected guild
const affectedGuilds = 3;
const newTotal = affectedGuilds * 1 + affectedGuilds * 1; // batch-release + recovery rollup

// Scenario 2: an entire 50-agent guild dies (coordinator included)
const scenario2 = {
  missed_heartbeats_detected: 2,          // spine misses 2 GUILD-HEARTBEATs
  fence_namespace_event: 1,
  reaper_releases_orphans_events: 0,      // server-side, zero room events
  reoffer_partition_event: 1,             // one CLAIM-ROLLUP-shaped re-offer
  total: 4,
};

const result = {
  scenario: '50 agents die mid-wave across 3 guilds',
  dead_agents: DEAD,
  old_handling_events: oldTotal,
  new_handling_events: newTotal,
  savings_ratio: +(oldTotal / newTotal).toFixed(1),
  event_reduction_pct: +(100 * (1 - newTotal / oldTotal)).toFixed(1),
  room_events_until_whole_again: { old: oldTotal, new: newTotal },
  scenario2_whole_guild_dies: scenario2,
};

mkdirSync('wave500-sim', { recursive: true });
writeFileSync('wave500-sim/failure-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
