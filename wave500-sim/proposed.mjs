// Proposed: one 500-agent wave under the SCALE discipline.
// 10 guilds x 50 agents. Per-task claim ops on ?fast=1 = 0 room events.
// Spine carries only rollups. Workers never post to the room.
import { writeFileSync, mkdirSync } from 'node:fs';

const AGENTS = 500, GUILDS = 10;
// Per guild spine posts: charter(1) + claim-rollup(1) + heartbeats(2) + progress-rollup(1) + done-rollup(1)
const perGuild = { charter: 1, claim_rollup: 1, heartbeats: 2, progress_rollup: 1, done_rollup: 1 };
const guildEvents = GUILDS * Object.values(perGuild).reduce((a, b) => a + b, 0);

const handoffRate = 0.05, askRate = 0.02; // per task
const handoffs = AGENTS * handoffRate * 1;
const asks = AGENTS * askRate * 1;
const perTaskRoomEvents = 0; // ?fast=1

const total = Math.round(guildEvents + handoffs + asks);
const baseline = 6.5 * AGENTS; // 3,250 under current discipline

const result = {
  discipline: 'proposed (guild rollups + ?fast=1)',
  agents: AGENTS,
  guilds: GUILDS,
  per_guild_spine_posts: perGuild,
  guild_spine_events: guildEvents,
  cross_guild_handoffs: Math.round(handoffs),
  spine_escalated_asks: Math.round(asks),
  per_task_room_events: perTaskRoomEvents,
  total_room_events: total,
  lifetime_budget: 10000,
  budget_burned_pct: +(100 * total / 10000).toFixed(2),
  events_per_agent: +(total / AGENTS).toFixed(3),
  vs_baseline_ratio: +(total / baseline).toFixed(4),
  event_reduction_pct: +(100 * (1 - total / baseline)).toFixed(1),
  waves_until_budget_dead: Math.floor(10000 / total),
};

mkdirSync('wave500-sim', { recursive: true });
writeFileSync('wave500-sim/proposed-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
