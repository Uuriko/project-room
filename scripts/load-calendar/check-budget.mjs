#!/usr/bin/env node
// check-budget.mjs — load-calendar guild budget checker (worker w3).
// Sums registered probing intent over overlapping windows (sweep-line) and
// warns when planned load exceeds the seed thresholds in thresholds.json.
// stdlib only. Never probes anything; it only reads the two input files.
//
// Usage:
//   node check-budget.mjs --registry <file> --thresholds <file> [--fixture <name>]
//
// --registry accepts either a JSON array of intent records, or an object whose
// values are such arrays (e.g. check-budget.test-fixtures.json); --fixture
// selects one named array from the object form.
// Exit 0: all checks OK. Exit 2: at least one WARN, with offending intent_ids.

import { readFileSync } from 'node:fs';

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--registry') out.registry = argv[++i];
    else if (argv[i] === '--thresholds') out.thresholds = argv[++i];
    else if (argv[i] === '--fixture') out.fixture = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') { usage(); process.exit(0); }
  }
  if (!out.registry) die('missing --registry <file>');
  if (!out.thresholds) die('missing --thresholds <file>');
  return out;
}
function usage() {
  console.log('usage: node check-budget.mjs --registry <file> --thresholds <file> [--fixture <name>]');
}

const { registry: regFile, thresholds: thrFile, fixture: fixtureName } = parseArgs(process.argv.slice(2));

const registryData = JSON.parse(readFileSync(regFile, 'utf8'));
const T = JSON.parse(readFileSync(thrFile, 'utf8'));

let registry;
if (Array.isArray(registryData)) {
  if (fixtureName) die('--fixture given but registry file is a plain array');
  registry = registryData;
} else if (registryData && typeof registryData === 'object') {
  if (!fixtureName) die('registry file is a named-fixture object; pass --fixture <name>');
  const fx = registryData[fixtureName];
  // Fixtures may be bare arrays, or { _comment, intents: [...] } wrappers.
  if (Array.isArray(fx)) registry = fx;
  else if (fx && Array.isArray(fx.intents)) registry = fx.intents;
  else die(`fixture '${fixtureName}' not found or has no intents array`);
} else die('registry file must contain a JSON array or a named-fixture object');

// Only planned/active intents count toward load.
const intents = registry.filter(r => r && (r.status === 'planned' || r.status === 'active'));

// Target classification: target starting with "scratch:" is scratch; api: routes
// and room names (e.g. muse-room) are production. Missing/odd targets fail closed
// as production.
const isScratch = r => typeof r.target === 'string' && r.target.startsWith('scratch:');
const isProduction = r => !isScratch(r);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Sweep-line: maximum simultaneous sum of weightFn over [start, end) windows.
// End events sort before start events at the same timestamp so touching windows
// do not phantom-overlap. Returns { max, peakStart } where peakStart is the
// window-start timestamp at which the max was observed.
function sweepLine(items, weightFn) {
  const events = [];
  for (const it of items) {
    const s = Date.parse(it.window_start);
    const e = Date.parse(it.window_end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const w = weightFn(it);
    events.push({ t: s, delta: w, type: 'start' });
    events.push({ t: e, delta: -w, type: 'end' });
  }
  events.sort((a, b) => a.t - b.t || (a.type === 'end' ? -1 : 1));
  let cur = 0, max = 0, peakStart = null;
  for (const ev of events) {
    cur += ev.delta;
    if (cur > max) { max = cur; peakStart = ev.t; }
  }
  return { max, peakStart };
}

const idsAtPeak = (items, peakT) =>
  items
    .filter(it => Date.parse(it.window_start) <= peakT && peakT < Date.parse(it.window_end))
    .map(it => it.intent_id);

const prod = intents.filter(isProduction);
const readsProd = prod.filter(r => r.kind === 'read');
const writesProd = prod.filter(r => r.kind === 'write' || r.kind === 'flood');
const mints = intents.filter(r => r.kind === 'mint');
const scratchOnlyViolations = prod.filter(r => r.kind === 'write' || r.kind === 'flood' || r.kind === 'mint');
const claimUpdatesProd = prod.filter(
  r => r.kind === 'update' || r.kind === 'claim_update' || r.kind === 'claim-update' ||
       (r.kind === 'write' && typeof r.target === 'string' && /claim/i.test(r.target))
);

const results = []; // { name, warn, detail, ids }
function check(name, warn, detail, ids = []) {
  results.push({ name, warn, detail, ids: [...new Set(ids)] });
}

// 1. Production read aggregate (kinds: read) over overlapping windows.
{
  const { max, peakStart } = sweepLine(readsProd, r => num(r.rate_rps));
  const budget = T.production_read_rps_aggregate.value;
  check('production_read_rps_aggregate', max > budget,
    `max simultaneous ${max.toFixed(2)} rps vs budget ${budget} rps` +
    (peakStart != null ? ` at ${new Date(peakStart).toISOString()}` : ''),
    max > budget && peakStart != null ? idsAtPeak(readsProd, peakStart) : []);
}

// 2. Production write aggregate (kinds: write, flood) over overlapping windows.
{
  const { max, peakStart } = sweepLine(writesProd, r => num(r.rate_rps));
  const budget = T.production_write_rps_aggregate.value;
  check('production_write_rps_aggregate', max > budget,
    `max simultaneous ${max.toFixed(2)} rps vs budget ${budget} rps` +
    (peakStart != null ? ` at ${new Date(peakStart).toISOString()}` : ''),
    max > budget && peakStart != null ? idsAtPeak(writesProd, peakStart) : []);
}

// 3. Write/flood/mint on production: forbidden — scratch only per convention rule 3
//    (seed threshold production_write_flood_mint_scratch_only = true).
{
  const forbidden = T.production_write_flood_mint_scratch_only.value === true;
  check('write_flood_mint_scratch_only', forbidden && scratchOnlyViolations.length > 0,
    forbidden
      ? `${scratchOnlyViolations.length} production intent(s) of kind write/flood/mint — must target scratch only`
      : 'scratch-only gate disabled in thresholds; skipping',
    scratchOnlyViolations.map(r => r.intent_id));
}

// 4. Production claim updates: forbidden (0 allowed — 136s hang observed).
{
  const allowed = T.production_claim_update_allowed.value;
  check('production_claim_update_forbidden', claimUpdatesProd.length > allowed,
    `${claimUpdatesProd.length} production claim-update intent(s); allowed: ${allowed}`,
    claimUpdatesProd.map(r => r.intent_id));
}

// 5. Identity mint aggregate (scratch-only mints) over overlapping windows.
{
  const { max, peakStart } = sweepLine(mints.filter(isScratch), r => num(r.rate_rps));
  const budget = T.identity_mint_rps_aggregate.value;
  check('identity_mint_rps_aggregate', max > budget,
    `max simultaneous ${max.toFixed(2)} rps vs budget ${budget} rps` +
    (peakStart != null ? ` at ${new Date(peakStart).toISOString()}` : ''),
    max > budget && peakStart != null ? idsAtPeak(mints.filter(isScratch), peakStart) : []);
}

// 6. Per-guild production caps: <= 1 rps sustained AND <= 200 requests total per
//    window. rps is the max simultaneous sum across the guild's overlapping
//    windows; totals likewise.
{
  const byGuild = new Map();
  for (const r of prod) {
    if (!byGuild.has(r.guild)) byGuild.set(r.guild, []);
    byGuild.get(r.guild).push(r);
  }
  for (const [guild, items] of byGuild) {
    const { max: rps, peakStart } = sweepLine(items, r => num(r.rate_rps));
    const { max: tot } = sweepLine(items, r =>
      (typeof r.expected_total === 'number' && Number.isFinite(r.expected_total)) ? r.expected_total : Infinity);
    const rpsBudget = T.per_guild_production_rps.value;
    const totBudget = T.per_guild_production_total_per_window.value;
    const badRps = rps > rpsBudget;
    const badTot = tot > totBudget;
    check(`per_guild_cap[${guild}]`, badRps || badTot,
      badRps && badTot
        ? `rps ${rps.toFixed(2)} > ${rpsBudget} AND total ${tot} > ${totBudget} per window`
        : badRps
          ? `rps ${rps.toFixed(2)} > ${rpsBudget} per guild cap`
          : badTot
            ? `total ${tot} > ${totBudget} requests per window per guild`
            : `rps ${rps.toFixed(2)} <= ${rpsBudget}, total ${tot} <= ${totBudget}`,
      (badRps || badTot) && peakStart != null ? idsAtPeak(items, peakStart) : items.map(r => r.intent_id));
  }
}

// kind 'join' is not in any aggregate class (open convention question: "Should
// join need an intent at all?"); it still counts toward the per-guild cap above
// because it hits production.

// Report: one OK/WARN line per check with the numbers.
let anyWarn = false;
for (const r of results) {
  const tag = r.warn ? 'WARN' : 'OK  ';
  const ids = r.warn && r.ids.length ? ` intent_ids=[${r.ids.join(', ')}]` : '';
  console.log(`${tag} ${r.name}: ${r.detail}${ids}`);
  if (r.warn) anyWarn = true;
}
process.exit(anyWarn ? 2 : 0);
