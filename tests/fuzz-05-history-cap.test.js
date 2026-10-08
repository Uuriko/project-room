// WAVE-400 fuzz-05: claim-history cap / summarization fuzz for
// stampClaimHistory / summarizeClaimHistory / claimHistoryLength / MAX_CLAIM_HISTORY
// in server/work-claims.mjs. TEST-ONLY. Seeded mulberry32 RNG.
// Invariants under test:
//   H1: history.length NEVER exceeds MAX_CLAIM_HISTORY (200) after any stamp/summarize.
//   H2: newest entries are retained, oldest are dropped (history == tail of stamped actions).
//   H3: claimHistoryLength(item) == lifetime stamped count; every successful stamp adds
//       exactly 1; summarize never changes the lifetime count.
//   H4: summarize is idempotent: summarize(summarize(h, keep), keep) deep-equals
//       summarize(h, keep) for every probed keep.
//   H5: no unbounded memory growth across the campaign (heap delta bounded).
//   H6: invalid inputs (empty/non-string action, bad agent id) throw invalid_claim_input
//       and leave the item untouched.
// KNOWN-FAILING (confirmed bugs, do NOT "fix" the tests -- fix server/work-claims.mjs):
//   BUG-A: summarizeClaimHistory(item, keep<0) is not idempotent and inflates the
//          lifetime count on every call (violates H3, H4).
//   BUG-B: summarizeClaimHistory(item, fractional keep) is not idempotent and corrupts
//          historyOmitted/lifetime count (violates H3, H4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stampClaimHistory, summarizeClaimHistory, claimHistoryLength, MAX_CLAIM_HISTORY,
} from '../server/work-claims.mjs';

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-05] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const rint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const T0 = Date.parse('2026-10-08T14:00:00.000Z'); // fixed anchor, no Date.now() anywhere

// ---- hostile string alphabets ----
const ASCII = 'abcdefghijklmnopqrstuvwxyz0123456789 _-.,:;!?@#$%^&*()[]{}<>/\\|\'"`~+=';
const UNICODE = ['\u{1F600}', '\u{1F680}', '\u{1F4A9}', '日本語', 'العربية', 'हिन्दी', 'Ω≈ç√', '\u200B', '\u200E\u200F', 'é', 'ﬁ', 'Å', '👨‍👩‍👧‍👦', '🏳️‍🌈', '\u0301', '\uD800', '\uDC00'];
const HOSTILE = ['__proto__', 'constructor', 'prototype', 'toString', '\0', '\n\r\t', 'a'.repeat(100000),
  'x'.repeat(10000) + '\0' + 'y'.repeat(10000), '{{7*7}}', '${jndi:ldap://x}', '<script>alert(1)</script>',
  'DROP TABLE claims;--', '\uFFFD', 'ß'.repeat(50000)];
function rstr(len, hostileP = 0.08) {
  if (rand() < hostileP) return pick(HOSTILE);
  let s = '';
  while (s.length < len) {
    const r = rand();
    if (r < 0.12) s += pick(UNICODE);
    else s += ASCII[Math.floor(rand() * ASCII.length)];
  }
  return s;
}

const ACTIONS = ['note', 'progress', 'state:claimed', 'state:in_progress', 'pr_opened', 'pr_merged', 'ack', 'update'];
const NOTES = [null, undefined, '', 'ok', 'short note'];

const newWork = i => ({ id: `fuzz05-w${i}`, title: `fuzz05 work ${i}` });
const agentFor = i => `fuzz05-agent${i % 37}`;

function validStampArgs(i, seq) {
  return {
    agentId: agentFor(i),
    opts: {
      action: rand() < 0.75 ? pick(ACTIONS) : rstr(rint(1, 60)),
      note: rand() < 0.6 ? pick(NOTES) : rstr(rint(0, 200)),
      now: T0 + seq * 7 + rint(0, 5),
    },
  };
}

const VALID_KEEPS = [0, 1, 2, 3, 10, 199, 200, 201, 1000, 1e12, Number.MAX_SAFE_INTEGER];

let stampsRun = 0;
let summarizesRun = 0;

test('H1/H2/H3/H5: 1000 works x 500 stamps + interleaved summarize, valid domain', () => {
  const heapBefore = process.memoryUsage().heapUsed;
  const WORKS = 1000, STAMPS = 500;
  for (let i = 0; i < WORKS; i++) {
    let work = newWork(i);
    let oracle = []; // actions stamped since last summarize (or start), in order
    let base = [];   // action list of history right after last summarize (or start)
    let lifetime = 0;
    for (let s = 0; s < STAMPS; s++) {
      // ~2%: invalid action must throw invalid_claim_input and not mutate
      if (rand() < 0.02) {
        const bad = rand() < 0.5 ? '' : pick([null, undefined, 42, {}, []]);
        const before = work;
        assert.throws(
          () => stampClaimHistory(work, agentFor(i), { action: bad, now: T0 + s }),
          err => err && err.code === 'invalid_claim_input',
          `work ${i} stamp ${s}: bad action must throw invalid_claim_input`);
        assert.strictEqual(work, before, `work ${i}: failed stamp must not replace the item`);
        continue;
      }
      const { agentId, opts } = validStampArgs(i, s);
      const lenBefore = claimHistoryLength(work);
      const next = stampClaimHistory(work, agentId, opts);
      stampsRun++;
      lifetime++;
      // H1: cap
      assert.ok(next.history.length <= MAX_CLAIM_HISTORY,
        `work ${i} stamp ${s}: history.length ${next.history.length} exceeds cap ${MAX_CLAIM_HISTORY}`);
      // H3: lifetime advances by exactly 1
      assert.strictEqual(claimHistoryLength(next), lenBefore + 1,
        `work ${i} stamp ${s}: claimHistoryLength ${claimHistoryLength(next)} != ${lenBefore} + 1`);
      assert.strictEqual(claimHistoryLength(next), lifetime,
        `work ${i} stamp ${s}: lifetime drift`);
      // newest stamp is last; frozen
      const last = next.history[next.history.length - 1];
      assert.strictEqual(last.action, opts.action, `work ${i} stamp ${s}: newest entry not last`);
      assert.strictEqual(last.agentId, agentId);
      assert.ok(Object.isFrozen(last), `work ${i}: stamp not frozen`);
      assert.ok(Object.isFrozen(next), `work ${i}: work not frozen`);
      assert.strictEqual(next.updatedAt, new Date(opts.now).toISOString());
      oracle.push(opts.action);
      // H2: history == tail of (base + oracle), newest retained
      if (s % 25 === 0 || i === 0) {
        const expected = [...base, ...oracle].slice(-MAX_CLAIM_HISTORY);
        assert.deepStrictEqual(next.history.map(h => h.action), expected,
          `work ${i} stamp ${s}: history is not the newest tail`);
      }
      work = next;
      // interleaved summarize every ~50 stamps, valid keep
      if (s % 50 === 49) {
        const keep = pick(VALID_KEEPS);
        const preLen = claimHistoryLength(work);
        const preTail = work.history.map(h => h.action);
        const sum1 = summarizeClaimHistory(work, keep);
        const sum2 = summarizeClaimHistory(sum1, keep);
        summarizesRun += 2;
        // H1
        assert.ok(sum1.history.length <= MAX_CLAIM_HISTORY, `work ${i}: summarize keep=${keep} exceeded cap`);
        assert.ok(sum1.history.length <= Math.max(keep, 0) || keep > MAX_CLAIM_HISTORY,
          `work ${i}: summarize keep=${keep} kept ${sum1.history.length}`);
        // H2: keeps newest (keep=0 keeps nothing; slice(-0) would wrongly keep all)
        const wantTail = keep <= 0 ? [] : preTail.slice(-keep);
        assert.deepStrictEqual(sum1.history.map(h => h.action), wantTail,
          `work ${i}: summarize keep=${keep} did not keep newest`);
        // H3: lifetime preserved by summarize
        assert.strictEqual(claimHistoryLength(sum1), preLen,
          `work ${i}: summarize keep=${keep} changed lifetime ${preLen} -> ${claimHistoryLength(sum1)}`);
        // H4: idempotent
        assert.deepStrictEqual(sum2, sum1, `work ${i}: summarize keep=${keep} not idempotent`);
        work = sum1;
        base = sum1.history.map(h => h.action);
        oracle = [];
      }
    }
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMB = (heapAfter - heapBefore) / 1048576;
  console.log(`[fuzz-05] campaign: ${WORKS * STAMPS} stamp attempts, ${stampsRun} successful, ${summarizesRun} summarizes, heap delta ${deltaMB.toFixed(1)}MB`);
  // H5: 500k frozen stamps + 500k frozen claim copies must stay well under 2GB
  assert.ok(deltaMB < 2048, `heap grew ${deltaMB.toFixed(1)}MB: unbounded growth suspected`);
});

test('H6: invalid agent id throws invalid_claim_input', () => {
  const work = newWork(4242);
  for (const bad of ['', null, undefined, 42, 'x'.repeat(129)]) {
    assert.throws(
      () => stampClaimHistory(work, bad, { action: 'note', now: T0 }),
      err => err && err.code === 'invalid_claim_input',
      `agentId ${JSON.stringify(bad)} must throw invalid_claim_input`);
  }
});

test('H2/H3/H4 deterministic: summarize keeps newest keep, preserves lifetime, idempotent', () => {
  let work = newWork(9001);
  const N = 150; // under MAX_CLAIM_HISTORY so no cap trimming interferes with the oracle
  for (let i = 0; i < N; i++) work = stampClaimHistory(work, 'a1', { action: `act-${i}`, now: T0 + i });
  for (const keep of [0, 1, 7, 199, 200, 250, 1000]) {
    const s1 = summarizeClaimHistory(work, keep);
    const s2 = summarizeClaimHistory(s1, keep);
    const want = Math.min(keep, N);
    assert.strictEqual(s1.history.length, want, `keep=${keep}: length`);
    assert.deepStrictEqual(s1.history.map(h => h.action),
      Array.from({ length: want }, (_, k) => `act-${N - want + k}`), `keep=${keep}: newest retained`);
    assert.strictEqual(claimHistoryLength(s1), N, `keep=${keep}: lifetime preserved`);
    assert.deepStrictEqual(s2, s1, `keep=${keep}: idempotent`);
  }
});

// BUG-A (confirmed 2026-10-08): negative keep breaks idempotency and inflates the
// lifetime count on every summarize call. Minimal repro below; fix belongs in
// server/work-claims.mjs summarizeClaimHistory (clamp/sanitize keep).
test('BUG-A: summarizeClaimHistory with negative keep is idempotent and preserves lifetime', () => {
  let work = newWork(9002);
  for (let i = 0; i < 10; i++) work = stampClaimHistory(work, 'a1', { action: `act-${i}`, now: T0 + i });
  for (const keep of [-1, -3, -200, -1000, -Infinity]) {
    const before = claimHistoryLength(work);
    const s1 = summarizeClaimHistory(work, keep);
    const s2 = summarizeClaimHistory(s1, keep);
    assert.strictEqual(claimHistoryLength(s1), before,
      `keep=${keep}: summarize changed lifetime ${before} -> ${claimHistoryLength(s1)} (H3 violated)`);
    assert.deepStrictEqual(s2, s1,
      `keep=${keep}: summarize(summarize(h)) != summarize(h) (H4 violated)`);
  }
});

// BUG-B (confirmed 2026-10-08): fractional keep breaks idempotency and corrupts
// historyOmitted (becomes fractional, e.g. 8.5), so claimHistoryLength no longer
// reports the lifetime count. Minimal repro below; fix belongs in
// server/work-claims.mjs summarizeClaimHistory (floor/sanitize keep).
test('BUG-B: summarizeClaimHistory with fractional keep is idempotent and preserves lifetime', () => {
  let work = newWork(9003);
  for (let i = 0; i < 10; i++) work = stampClaimHistory(work, 'a1', { action: `act-${i}`, now: T0 + i });
  for (const keep of [0.5, 1.5, 2.5, 199.9]) {
    const before = claimHistoryLength(work);
    const s1 = summarizeClaimHistory(work, keep);
    const s2 = summarizeClaimHistory(s1, keep);
    assert.ok(Number.isSafeInteger(s1.historyOmitted ?? 0) || s1.historyOmitted === undefined,
      `keep=${keep}: historyOmitted is fractional (${s1.historyOmitted})`);
    assert.strictEqual(claimHistoryLength(s1), before,
      `keep=${keep}: summarize changed lifetime ${before} -> ${claimHistoryLength(s1)} (H3 violated)`);
    assert.deepStrictEqual(s2, s1,
      `keep=${keep}: summarize(summarize(h)) != summarize(h) (H4 violated)`);
  }
});

test('probe: hostile keep sweep reports findings (NaN/undefined/Infinity)', () => {
  const findings = [];
  for (const n of [0, 1, 5, 10, 250]) {
    let work = newWork(9100 + n);
    for (let i = 0; i < n; i++) work = stampClaimHistory(work, 'a1', { action: `act-${i}`, now: T0 + i });
    for (const keep of [NaN, undefined, Infinity]) {
      const before = claimHistoryLength(work);
      const s1 = summarizeClaimHistory(work, keep);
      const s2 = summarizeClaimHistory(s1, keep);
      const idem = (() => { try { assert.deepStrictEqual(s2, s1); return true; } catch { return false; } })();
      if (!idem) findings.push(`n=${n} keep=${String(keep)}: NOT idempotent`);
      if (claimHistoryLength(s1) !== before) findings.push(`n=${n} keep=${String(keep)}: lifetime ${before} -> ${claimHistoryLength(s1)}`);
      if (s1.historyOmitted !== undefined && !Number.isSafeInteger(s1.historyOmitted)) {
        findings.push(`n=${n} keep=${String(keep)}: historyOmitted=${s1.historyOmitted} (not a safe integer)`);
      }
    }
  }
  console.log(`[fuzz-05] hostile-keep probe findings (${findings.length}):`);
  for (const f of findings) console.log(`[fuzz-05]   ${f}`);
  // Informational only: garbage-in keep values are outside the documented domain.
});
