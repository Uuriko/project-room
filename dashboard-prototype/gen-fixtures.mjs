#!/usr/bin/env node
// gen-fixtures.mjs — regenerate dashboard-prototype/fixtures/*.json deterministically.
// SYNTHETIC DATA ONLY: all agents, claims and events are canned for the static
// dashboard prototype. Never real room data, never a live endpoint.
// usage: node gen-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(outDir, { recursive: true });

// Deterministic PRNG (mulberry32) so fixtures are stable across regenerations.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(0x27 /* guild 27 */);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const ri = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));

const GENERATED_AT = '2026-10-09T07:00:00-07:00'; // fixture snapshot label, not live
const FIXTURE_NOTICE =
  'SYNTHETIC fixture data for the static dashboard prototype (guild-27). Not real room data.';

// ---------------------------------------------------------------- agents
const AGENT_ROWS = [
  ['instinct', 'LANE-D', 'verification/deploy'],
  ['jill', 'OWNER', 'room operations'],
  ['codex', 'LANE-C', 'shipping'],
  ['quill', 'MERGE', 'merge authority'],
  ['grokbot', 'PUBLISH', 'publishing lane'],
  ['tab', 'BROWSER', 'browser-box QA'],
  ['fo', 'EXTERNAL', 'outside agent (API+MCP)'],
  ['claude', 'BUILD', 'build lane'],
  ['arion', 'LANE-A', 'elevated perms'],
  ['nova-faryza', 'LANE-N', 'tantive'],
  ['grok-build', 'BUILD', 'build lane (black-box probe)'],
  ['jill-dot', 'LANE-J', 'grants verification (frozen)'],
  ['swarmbrain', 'AUTO', 'auto-approve rule'],
  ['ryska', 'LANE-R', 'lane member'],
];
const agents = AGENT_ROWS.map(([name, lane, role], i) => {
  const messages = [980, 870, 640, 610, 420, 380, 310, 260, 190, 150, 120, 96, 70, 45][i];
  const claims = [24, 31, 18, 22, 9, 12, 8, 14, 11, 6, 9, 4, 5, 3][i];
  const minutesAgo = [4, 1, 11, 6, 22, 9, 37, 58, 75, 140, 205, 460, 300, 900][i];
  return {
    id: `agent-${String(i + 1).padStart(2, '0')}`,
    name, lane, role,
    messages, claimsOpened: claims,
    claimsCompleted: Math.max(0, claims - ri(0, 3)),
    lastActiveMinutesAgo: minutesAgo,
    status: minutesAgo < 60 ? 'active' : minutesAgo < 300 ? 'idle' : 'away',
  };
});

// ---------------------------------------------------------------- claims board
const STATES = ['submitted', 'working', 'completed', 'cancelled', 'expired'];
const CLAIM_TOPICS = [
  'rebase-rescue', 'fail-first-regression', 'contrast-fix', 'openapi-drift',
  'invite-flow', 'advisory-review', 'fuzz-corpus', 'telemetry-gap',
  'doc-cookbook', 'benchmark-baseline', 'strike-triage', 'receipt-backfill',
];
const lanes = [...new Set(agents.map((a) => a.lane))];
const claims = [];
let seq = 1041;
for (let i = 0; i < 96; i++) {
  const lane = pick(lanes);
  const agent = pick(agents.filter((a) => a.lane === lane));
  const state = i < 18 ? 'working'
    : i < 30 ? 'submitted'
    : i < 78 ? 'completed'
    : i < 90 ? 'cancelled' : 'expired';
  const openedHrsAgo = ri(1, 24 * 7);
  claims.push({
    id: `WC-${seq++}`,
    title: `${pick(CLAIM_TOPICS)}: ${pick(['audit', 'fix', 'harness', 'doc pass', 're-verify', 'load test'])}`,
    state, lane, agent: agent.name,
    openedHoursAgo: openedHrsAgo,
    leaseHours: state === 'working' ? ri(4, 72) : null,
    strikes: state === 'expired' ? ri(1, 2) : state === 'cancelled' ? ri(0, 1) : 0,
  });
}
const byState = Object.fromEntries(STATES.map((s) => [s, claims.filter((c) => c.state === s).length]));
const claimsBoard = {
  notice: FIXTURE_NOTICE,
  generatedAt: GENERATED_AT,
  window: 'last 7 days',
  totals: {
    total: claims.length,
    ...byState,
    open: byState.submitted + byState.working,
    strikes: claims.reduce((n, c) => n + c.strikes, 0),
  },
  byLane: lanes.map((lane) => ({
    lane,
    open: claims.filter((c) => c.lane === lane && (c.state === 'submitted' || c.state === 'working')).length,
    completed: claims.filter((c) => c.lane === lane && c.state === 'completed').length,
    expired: claims.filter((c) => c.lane === lane && (c.state === 'expired' || c.state === 'cancelled')).length,
  })),
  claims, // full list for the drill-down table
};

// ---------------------------------------------------------------- events
// 24h of 15-minute buckets: events/min + per-type mix.
const EVENT_TYPES = ['message.posted', 'work.claimed', 'work.heartbeat', 'work.completed', 'work.released'];
const buckets = [];
for (let b = 0; b < 96; b++) {
  const hour = b / 4;
  // diurnal curve: quiet 02:00-06:00, busy 09:00-22:00 (PDT-ish)
  const diurnal = 0.25 + 0.75 * Math.exp(-Math.pow(hour - 15, 2) / 32) + 0.15 * Math.exp(-Math.pow(hour - 10, 2) / 18);
  const noise = 0.7 + R() * 0.6;
  const total = Math.round(14 * diurnal * noise * 10) / 10; // events per minute
  const mix = {
    'message.posted': Math.round(total * (0.55 + R() * 0.1) * 10) / 10,
    'work.claimed': Math.round(total * 0.06 * 10) / 10,
    'work.heartbeat': Math.round(total * 0.22 * 10) / 10,
    'work.completed': Math.round(total * 0.07 * 10) / 10,
    'work.released': Math.round(total * 0.04 * 10) / 10,
  };
  buckets.push({ bucketStartMinutes: b * 15, eventsPerMin: total, byType: mix });
}
const events = {
  notice: FIXTURE_NOTICE,
  generatedAt: GENERATED_AT,
  bucketMinutes: 15,
  totals: {
    eventsPerDay: Math.round(buckets.reduce((n, b) => n + b.eventsPerMin * 15, 0)),
    byType: Object.fromEntries(EVENT_TYPES.map((t) => [
      t, Math.round(buckets.reduce((n, b) => n + b.byType[t] * 15, 0)),
    ])),
  },
  buckets,
};

// ---------------------------------------------------------------- bundle
const write = (name, obj) => writeFileSync(join(outDir, name), JSON.stringify(obj, null, 2) + '\n');
write('agents.json', { notice: FIXTURE_NOTICE, generatedAt: GENERATED_AT, agents });
write('claims-board.json', claimsBoard);
write('events.json', events);
console.log('fixtures written to', outDir);
