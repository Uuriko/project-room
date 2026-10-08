#!/usr/bin/env node
/*
 * verify.mjs — w5 (verification), load-calendar guild, 200-agent exercise.
 *
 * Contract test suite for the probing-intent design (PROBING-INTENT-CONVENTION.md).
 * Usage: node verify.mjs --dir <components-dir>
 *
 * Stdlib only. Reimplements the schema rules INDEPENDENTLY from the sibling
 * components' code: this suite tests the DESIGN, not their implementation.
 *
 * Sections:
 *   1. Reference validator (schema rules re-derived from the convention draft).
 *   2. Design assertions: invalid fixtures fail for the right reason; the
 *      aggregation math (sweep-line over windows, 15-min buckets) pins the
 *      budgets, per-guild caps, and done/aborted exclusion.
 *   3. Component conformance: reports which sibling deliverables are present
 *      or MISSING. Informational only — never fails the design assertions.
 *
 * Exit 0: all design assertions pass. Exit 1: any design assertion failed.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
if (dirIdx < 0 || !argv[dirIdx + 1]) {
  console.error('usage: node verify.mjs --dir <components-dir>');
  process.exit(2);
}
const componentsDir = path.resolve(argv[dirIdx + 1]);

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'intents.json'), 'utf8')
).intents;

// ---------------------------------------------------------------------------
// 1. Reference validator — rules re-derived from PROBING-INTENT-CONVENTION.md
// ---------------------------------------------------------------------------

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(['read', 'write', 'flood', 'mint', 'join']);
const RAMPS = new Set(['gradual', 'burst']);
const STATUSES = new Set(['planned', 'active', 'done', 'aborted']);
const WRITE_KINDS = new Set(['write', 'flood', 'mint']); // scratch_only REQUIRED
const ACTIVE = new Set(['planned', 'active']); // statuses that count toward load

const isScratch = (t) => typeof t === 'string' && t.startsWith('scratch:');

function validate(intent, all) {
  const r = [];
  for (const f of ['intent_id', 'guild', 'contact', 'target', 'kind', 'rate_rps',
    'expected_total', 'window_start', 'window_end', 'scratch_only', 'ramp',
    'stop_condition', 'status']) {
    if (intent[f] === undefined || intent[f] === null || intent[f] === '') {
      r.push('MISSING_' + f.toUpperCase());
    }
  }
  if (intent.intent_id && !UUID4.test(intent.intent_id)) r.push('BAD_UUID');
  if (intent.kind && !KINDS.has(intent.kind)) r.push('UNKNOWN_KIND');
  if (intent.ramp && !RAMPS.has(intent.ramp)) r.push('UNKNOWN_RAMP');
  if (intent.status && !STATUSES.has(intent.status)) r.push('UNKNOWN_STATUS');
  if (typeof intent.rate_rps === 'number' && !(intent.rate_rps > 0)) r.push('BAD_RATE');
  if (typeof intent.expected_total === 'number' && !(intent.expected_total >= 0)) r.push('BAD_TOTAL');
  if (typeof intent.scratch_only !== 'boolean') r.push('BAD_SCRATCH_ONLY');

  const start = Date.parse(intent.window_start);
  const end = Date.parse(intent.window_end);
  if (Number.isNaN(start)) r.push('BAD_WINDOW_START');
  if (Number.isNaN(end)) r.push('BAD_WINDOW_END');
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    if (end <= start) r.push('BAD_WINDOW'); // end must be strictly after start
    if (end - start > 60 * 60 * 1000) r.push('WINDOW_TOO_LONG'); // rule 5: <=60min
  }

  if (all.filter((x) => x.intent_id === intent.intent_id).length > 1) r.push('DUPLICATE_ID');

  const scratch = isScratch(intent.target);
  if (WRITE_KINDS.has(intent.kind)) {
    if (intent.scratch_only !== true) r.push('WRITE_NEEDS_SCRATCH_ONLY');
    if (!scratch) r.push('WRITE_TARGET_NOT_SCRATCH');
  }
  if (intent.ramp === 'burst' && !scratch) r.push('BURST_NEEDS_SCRATCH');

  // Production claim updates are forbidden (seed threshold: 0 — not allowed).
  // There is no "claim-update" kind in the convention, so we detect the intent
  // by a claim-ish production target (see REPORT.md ambiguity A1).
  if (!scratch && typeof intent.target === 'string' && /claim/i.test(intent.target)) {
    r.push('CLAIM_UPDATE_FORBIDDEN');
  }

  return { valid: r.length === 0, reasons: r };
}

// ---------------------------------------------------------------------------
// 2. Independent aggregation math — sweep-line, 15-min buckets
// ---------------------------------------------------------------------------

const BUCKET_MS = 15 * 60 * 1000; // design decision: 15-minute buckets
const bucketStart = (ms) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
const bucketKey = (ms) => new Date(bucketStart(ms)).toISOString();

// Seed thresholds (design pins from the convention draft)
const TH = {
  prodReadAgg: 2,     // production reads, aggregate rps
  prodWriteAgg: 0.5,  // production writes, aggregate rps
  mintAgg: 0.2,       // minting, aggregate rps
  claimUpdates: 0,    // production claim updates: forbidden
  perGuildProdRps: 1, // per-guild production rps
  perGuildProdTotal: 200, // per-guild production expected_total per window
};

const results = validateFixtures();

// valid + planned/active + production target + kind read  -> production read load
function productionReads() {
  return FIXTURES.filter(
    (i) => results.get(i.intent_id).valid && ACTIVE.has(i.status) &&
      !isScratch(i.target) && i.kind === 'read'
  );
}

const readBuckets = new Map();      // bucketKey -> aggregate prod-read rps
const perGuildBuckets = new Map();  // guild -> bucketKey -> prod rps (all prod kinds)
for (const i of FIXTURES) {
  const v = results.get(i.intent_id);
  if (!v.valid || !ACTIVE.has(i.status) || isScratch(i.target)) continue;
  const start = Date.parse(i.window_start), end = Date.parse(i.window_end);
  for (let b = bucketStart(start); b < end; b += BUCKET_MS) {
    if (i.kind === 'read') {
      const k = new Date(b).toISOString();
      readBuckets.set(k, (readBuckets.get(k) || 0) + i.rate_rps);
    }
    const gk = i.guild + '|' + new Date(b).toISOString();
    perGuildBuckets.set(gk, (perGuildBuckets.get(gk) || 0) + i.rate_rps);
  }
}

function validateFixtures() {
  const m = new Map();
  for (const i of FIXTURES) m.set(i.intent_id, validate(i, FIXTURES));
  return m;
}

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  <-- ' + detail : '')); }
}
const approx = (a, b) => Math.abs(a - b) < 1e-9;

const id = (fixture) => FIXTURES.find((i) => i.fixture === fixture).intent_id;

// ---------------------------------------------------------------------------
// Section A: schema validation — invalid fixtures fail for the right reason
// ---------------------------------------------------------------------------
console.log('\n== A. Schema validation (reference validator) ==');

const EXPECTED_INVALID = {
  'F3 INVALID: write on production without scratch_only':
    ['WRITE_NEEDS_SCRATCH_ONLY', 'WRITE_TARGET_NOT_SCRATCH'],
  'F4 INVALID: burst ramp on production target':
    ['BURST_NEEDS_SCRATCH'],
  'F5a INVALID: duplicate intent_id (first)': ['DUPLICATE_ID'],
  'F5b INVALID: duplicate intent_id (second)': ['DUPLICATE_ID'],
  'F6 INVALID: window_end before window_start': ['BAD_WINDOW'],
  'F7 INVALID: unknown kind': ['UNKNOWN_KIND'],
  'F14 INVALID: production claim-update (forbidden)':
    ['CLAIM_UPDATE_FORBIDDEN', 'WRITE_NEEDS_SCRATCH_ONLY', 'WRITE_TARGET_NOT_SCRATCH'],
};

for (const [fixture, expectedReasons] of Object.entries(EXPECTED_INVALID)) {
  const v = results.get(id(fixture));
  const gotAll = expectedReasons.every((r) => v.reasons.includes(r));
  check(
    'invalid: ' + fixture,
    !v.valid && gotAll,
    JSON.stringify({ valid: v.valid, reasons: v.reasons, expected: expectedReasons })
  );
}

// Valid fixtures must validate cleanly (incl. done/aborted: valid schema, excluded from load later)
const EXPECTED_VALID = [
  'F1 valid production read', 'F2 valid scratch flood',
  'F8 overlap read 1/5', 'F9 overlap read 2/5', 'F10 overlap read 3/5',
  'F11 overlap read 4/5', 'F12 overlap read 5/5',
  'F13 per-guild production violation (1.5rps)',
  'F15 done intent (must NOT count toward load)',
  'F16 aborted intent (must NOT count toward load)',
];
for (const fixture of EXPECTED_VALID) {
  const v = results.get(id(fixture));
  check('valid: ' + fixture, v.valid, JSON.stringify(v.reasons));
}

// ---------------------------------------------------------------------------
// Section B: aggregation math — sweep-line over windows, 15-min buckets
// ---------------------------------------------------------------------------
console.log('\n== B. Aggregation math (independent sweep-line) ==');

const OVERLAP_BUCKET = '2026-10-08T03:00:00.000Z'; // five reads 03:00-03:05
const GUILD_BUCKET = '2026-10-08T03:30:00.000Z';   // hot guild 03:30-03:32

check(
  'overlap bucket aggregate production-read rps = 2.5',
  approx(readBuckets.get(OVERLAP_BUCKET) || 0, 2.5),
  'got ' + (readBuckets.get(OVERLAP_BUCKET) || 0)
);
check(
  'done/aborted intents excluded (would be 3.5 if counted)',
  approx(readBuckets.get(OVERLAP_BUCKET) || 0, 2.5),
  'got ' + (readBuckets.get(OVERLAP_BUCKET) || 0)
);
check(
  '2.5rps exceeds the 2rps production-read threshold -> WARN condition',
  (readBuckets.get(OVERLAP_BUCKET) || 0) > TH.prodReadAgg,
  'got ' + (readBuckets.get(OVERLAP_BUCKET) || 0)
);
check(
  'per-guild violation flagged: hot = 1.5rps > 1rps cap in its bucket',
  approx(perGuildBuckets.get('hot|' + GUILD_BUCKET) || 0, 1.5) &&
    (perGuildBuckets.get('hot|' + GUILD_BUCKET) || 0) > TH.perGuildProdRps,
  'got ' + (perGuildBuckets.get('hot|' + GUILD_BUCKET) || 0)
);
check(
  'scratch flood (10rps) contributes 0 to production-read buckets',
  ![...readBuckets.keys()].some((k) => (readBuckets.get(k) || 0) >= 10),
  'max bucket = ' + Math.max(0, ...readBuckets.values())
);
check(
  'F1 production read sits in a disjoint bucket (no cross-contamination)',
  approx(readBuckets.get('2026-10-08T04:00:00.000Z') || 0, 0.5),
  'got ' + (readBuckets.get('2026-10-08T04:00:00.000Z') || 0)
);
check(
  'per-guild production expected_total <= 200 for every valid production intent',
  FIXTURES.filter((i) => results.get(i.intent_id).valid && !isScratch(i.target))
    .every((i) => i.expected_total <= TH.perGuildProdTotal),
  'violations: ' + FIXTURES.filter((i) => results.get(i.intent_id).valid &&
    !isScratch(i.target) && i.expected_total > TH.perGuildProdTotal)
    .map((i) => i.intent_id).join(', ')
);
const warnBuckets = [...readBuckets.keys()]
  .filter((k) => (readBuckets.get(k) || 0) > TH.prodReadAgg).sort();
check(
  'exactly one WARN bucket (the overlap bucket)',
  warnBuckets.length === 1 && warnBuckets[0] === OVERLAP_BUCKET,
  'got ' + JSON.stringify(warnBuckets)
);

// ---------------------------------------------------------------------------
// Section C: component conformance (informational — never fails the design)
// ---------------------------------------------------------------------------
console.log('\n== C. Component conformance (informational only) ==');

const EXPECTED_FILES = [
  'intent-schema/intent.schema.json',
  'intent-schema/register-intent.mjs',
  'calendar-view/render-calendar.mjs',
  'budget-checker/check-budget.mjs',
  'budget-checker/thresholds.json',
];
let found = 0;
for (const f of EXPECTED_FILES) {
  const exists = fs.existsSync(path.join(componentsDir, f));
  if (exists) found++;
  console.log((exists ? 'FOUND    ' : 'MISSING  ') + f);
}
console.log(`conformance: ${found}/${EXPECTED_FILES.length} sibling files present` +
  (found < EXPECTED_FILES.length ? ' (siblings not landed yet — design assertions unaffected)' : ''));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n== Summary ==');
console.log(`design assertions: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS');
