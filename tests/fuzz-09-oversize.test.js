// WAVE-400 fuzz-09: oversized / resource-exhaustion battery.
// TEST-ONLY. Targets: claimWork/updateWork/renewWork/attestWork/recordReview/
// closeWork/createWork note fields, route-level boardText text guards, event
// bodies (workClaimEventData), history notes (withHistory caps), and giant
// arrays / deep-nested objects on every collection-typed claim field.
// Hostile inputs: 5MB single strings; 1M-char unicode; 100k-element arrays;
// objects nested 500 deep; notes at every length boundary.
// Invariants under test:
//   O1: an oversize note is rejected with a catchable ClaimError
//       (invalid_claim_input) — never a raw TypeError/RangeError that would
//       escape runPure as an HTTP 500 — and in well under 1s.
//   O2: a rejected oversize op leaves state untouched (frozen item identical).
//   O3: giant arrays are rejected on their length caps (O(1)), not walked.
//   O4: 500-deep objects never stack-overflow a validator.
//   O5: one claim op adds exactly one history stamp (never grows past caps in
//       one op); history per-claim storage is bounded by MAX_CLAIM_HISTORY x cap.
//   O6: route JSON bodies are capped at 16KiB -> 413 (code-verified; readText
//       is closed over in server/http.mjs and not unit-testable directly).
//   O7: process RSS stays under 1GB across the whole battery.
// Seeded mulberry32 RNG. seed = Number(process.env.FUZZ_SEED ?? 20261008).
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createWork, claimWork, updateWork, renewWork, attestWork, recordReview,
  closeWork, appendWorkPullRequest, stampClaimHistory, claimHistoryLength,
  MAX_CLAIM_HISTORY, ClaimError,
} from '../server/work-claims.mjs';
import { boardText } from '../server/work-claim-integrity.mjs';
import { readFileSync } from 'node:fs';
import { workClaimEventData } from '../server/work-claim-events.mjs';

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-09] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const T0 = Date.parse('2026-10-08T14:00:00.000Z'); // fixed anchor

let peakRssMB = 0;
function rssMB() { return process.memoryUsage().rss / 1048576; }
function trackRss(label) {
  const now = rssMB();
  if (now > peakRssMB) peakRssMB = now;
  if (now > 1024) throw new Error(`[fuzz-09] RSS exceeded 1GB at ${label}: ${now.toFixed(1)}MB`);
}

// Payloads are built once and reused (never copied) to keep RSS honest.
const FIVE_MB = 5 * 1024 * 1024;
const bigAscii = 'a'.repeat(FIVE_MB);                    // 5MB single string
const oneMEmoji = '🔥'.repeat(500_000);                  // 1M code units, 2MB bytes? no: 500k emoji = 2MB utf16 units? actually .repeat(500k) => 1M UTF-16 units
const oneMCombining = 'é'.repeat(1_000_000);            // e + U+0301, 2M code units
const loneSurrogates = '\uD800'.repeat(1_000_000);       // 1M unpaired surrogates
const hostile500k = 'x'.repeat(500_000);
const deepNested = (depth) => {
  let o = { leaf: 'x' };
  for (let i = 0; i < depth; i++) o = { nest: o };
  return o;
};

// Timing harness: every hostile op must finish (throw or return) in <1s.
const timed = (label, fn) => {
  const t0 = performance.now();
  let result, threw = null;
  try { result = fn(); } catch (e) { threw = e; }
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${label}: op took ${ms.toFixed(0)}ms (quadratic blowup suspected)`);
  if (threw) throw threw;
  return { result, ms };
};
// Expect a catchable ClaimError with invalid_claim_input (routes map it to
// 422; anything else would propagate through runPure as an HTTP 500).
const expectClaimInputError = (label, fn) => {
  const t0 = performance.now();
  let err = null;
  try { fn(); } catch (e) { err = e; }
  const ms = performance.now() - t0;
  assert.ok(err, `${label}: oversize input was ACCEPTED`);
  assert.ok(err instanceof ClaimError, `${label}: threw ${err?.constructor?.name ?? typeof err} (${err?.message}) — not a ClaimError, would be a 500`);
  assert.strictEqual(err.code, 'invalid_claim_input', `${label}: code ${err.code} is not invalid_claim_input`);
  assert.ok(ms < 1000, `${label}: rejection took ${ms.toFixed(0)}ms`);
  return ms;
};
const snapshot = item => JSON.stringify(item);
const assertUntouched = (label, item, before) => {
  assert.strictEqual(snapshot(item), before, `${label}: rejected op mutated state`);
};

// ---- fixtures ---------------------------------------------------------------
let claimSeq = 0;
function claimedClaim(agent = 'owner1', note = 'claim note') {
  claimSeq += 1;
  let work = createWork({ id: `fuzz09-w${claimSeq}`, title: `fuzz09 claim ${claimSeq}`, note: 'create note' }, { now: T0, agentId: agent });
  work = claimWork(work, agent, { note, now: T0 + 1000 });
  return work;
}
const boardReject = (status, code, message) => {
  const e = new Error(message);
  e.status = status; e.code = code;
  throw e;
};

// ---- O1/O2: 5MB notes on every note-bearing op ------------------------------
// The 4000-char note cap is enforced in the state machine (claimWork,
// updateWork, renewWork, closeWork, createWork), the 512 cap in attestWork,
// the 2000 cap in recordReview's summary. All must throw ClaimError
// (invalid_claim_input -> HTTP 422) fast and leave the item untouched.
const NOTE_OPS = [
  { label: 'claimWork', make: () => createWork({ id: `fuzz09-nc${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }),
    run: (item, note) => claimWork(item, 'owner1', { note, now: T0 + 1 }) },
  { label: 'updateWork', make: () => claimedClaim(),
    run: (item, note) => updateWork(item, 'owner1', { note, now: T0 + 2 }) },
  { label: 'renewWork', make: () => claimedClaim(),
    run: (item, note) => renewWork(item, 'owner1', { note, now: T0 + 3 }) },
  { label: 'attestWork', make: () => claimedClaim(),
    run: (item, note) => attestWork(item, 'reviewer1', { note, now: T0 + 4 }) },
  { label: 'recordReview-summary', make: () => claimedClaim(),
    run: (item, summary) => recordReview(item, 'reviewer1', { verdict: 'approve', summary, now: T0 + 5 }) },
  { label: 'closeWork-reason', make: () => claimedClaim(),
    run: (item, reason) => closeWork(item, 'owner1', { verb: 'close', reason, now: T0 + 6 }) },
  { label: 'createWork', make: () => null,
    run: (_, note) => createWork({ id: `fuzz09-nk${claimSeq++}`, title: 't', note }, { now: T0, agentId: 'owner1' }) },
];
const NOTE_PAYLOADS = [
  ['5MB-ascii', bigAscii],
  ['500k-emoji-1M-units', oneMEmoji],
  ['500k-e+combining', oneMCombining],
  ['500k-x', hostile500k],
  ['1M-lone-surrogates', loneSurrogates],
];
for (const op of NOTE_OPS) {
  test(`O1/O2: ${op.label} rejects hostile notes with 4xx semantics, state untouched, sub-second`, () => {
    for (const [pname, payload] of NOTE_PAYLOADS) {
      const item = op.make();
      const before = item === null ? null : snapshot(item);
      const ms = expectClaimInputError(`${op.label}/${pname}`, () => op.run(item, payload));
      if (item !== null) {
        assertUntouched(`${op.label}/${pname}`, item, before);
        assert.ok(Object.isFrozen(item), `${op.label}/${pname}: input lost frozenness`);
      }
      trackRss(`${op.label}/${pname}`);
    }
    console.log(`[fuzz-09] ${op.label}: 5 hostile notes rejected (ClaimError/invalid_claim_input, sub-second)`);
  });
}

test('O1 boundary: exactly-4000 note accepted, 4001 rejected (claimWork)', () => {
  const at4000 = 'n'.repeat(4000);
  const at4001 = 'n'.repeat(4001);
  let work = createWork({ id: `fuzz09-b${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' });
  const { result: claimed, ms } = timed('claimWork-4000', () => claimWork(work, 'owner1', { note: at4000, now: T0 + 1 }));
  assert.ok(claimed.history.at(-1).note.length === 4000);
  trackRss('claimWork-4000');
  const item = claimedClaim();
  expectClaimInputError('claimWork-4001', () => claimWork(
    createWork({ id: `fuzz09-bb${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }),
    'owner1', { note: at4001, now: T0 + 1 }));
});

test('O1/O2: recordReview url of 5MB rejected fast (300-char url cap)', () => {
  const item = claimedClaim();
  const before = snapshot(item);
  expectClaimInputError('recordReview-url-5MB', () =>
    recordReview(item, 'reviewer1', { verdict: 'approve', summary: 'ok', url: 'https://x/' + 'a'.repeat(FIVE_MB), now: T0 + 5 }));
  assertUntouched('recordReview-url-5MB', item, before);
  trackRss('recordReview-url-5MB');
});

test('O1/O2: appendWorkPullRequest 5MB url rejected fast (300-char cap)', () => {
  const item = claimedClaim();
  const before = snapshot(item);
  expectClaimInputError('appendWorkPullRequest-5MB', () =>
    appendWorkPullRequest(item, 'owner1', {
      pullRequest: 'https://github.com/x/y/pull/' + '1'.repeat(FIVE_MB),
      expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: T0 + 7,
    }));
  assertUntouched('appendWorkPullRequest-5MB', item, before);
  trackRss('appendWorkPullRequest-5MB');
});

// ---- O3: 100k-element arrays are rejected on their length caps ------------
// tags/blobs (10), files (64), dependsOn (16), pullRequests (16), evidenceRefs
// (16). The length check precedes any element walk: rejection must be O(1)
// and leave state untouched.
test('O3: 100k-element arrays rejected on length caps, O(1), state untouched', () => {
  const item = claimedClaim();
  const before = snapshot(item);
  const cases = [
    ['tags-100k', () => updateWork(item, 'owner1', { state: 'done', tags: new Array(100_000).fill('ok'), now: T0 + 10 })],
    ['blobs-100k', () => updateWork(item, 'owner1', { state: 'done', blobs: new Array(100_000).fill('sha256:' + 'a'.repeat(64)), now: T0 + 10 })],
    ['files-100k', () => claimWork(createWork({ id: `fuzz09-f${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }), 'owner1', { files: new Array(100_000).fill('a.js'), now: T0 + 10 })],
    ['dependsOn-100k', () => claimWork(createWork({ id: `fuzz09-d${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }), 'owner1', { dependsOn: new Array(100_000).fill('dep-id'), now: T0 + 10 })],
    ['pullRequests-100k', () => claimWork(createWork({ id: `fuzz09-p${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }), 'owner1', { pullRequests: new Array(100_000).fill('https://github.com/a/b/pull/1'), now: T0 + 10 })],
    ['evidenceRefs-100k', () => updateWork(item, 'owner1', { note: 'x', evidenceRefs: new Array(100_000).fill('sha256:' + 'b'.repeat(64)), now: T0 + 10 })],
  ];
  for (const [label, fn] of cases) {
    const ms = expectClaimInputError(label, fn);
    assert.ok(ms < 200, `${label}: ${ms.toFixed(0)}ms — cap check should be O(1), elements may have been walked`);
    assertUntouched(label, item, before);
    trackRss(label);
  }
});

test('O3: exactly-at-cap arrays accepted fast (files x64, dependsOn x16)', () => {
  const { result: claimed, ms: msFiles } = timed('claimWork-files-64', () =>
    claimWork(createWork({ id: `fuzz09-f64${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }),
      'owner1', { files: Array.from({ length: 64 }, (_, i) => `dir/file${i}.js`), now: T0 + 11 }));
  assert.strictEqual(claimed.files.length, 64);
  const { result: updated } = timed('claimWork-dependsOn-16', () =>
    claimWork(createWork({ id: `fuzz09-d16${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }),
      'owner1', { dependsOn: Array.from({ length: 16 }, (_, i) => `dep${i}`), now: T0 + 12 }));
  assert.strictEqual(updated.dependsOn.length, 16);
  trackRss('at-cap-arrays');
});

// ---- O4: 500-deep objects never stack-overflow -----------------------------
test('O4: 500-deep nested objects rejected cleanly (no stack overflow)', () => {
  const item = claimedClaim();
  const before = snapshot(item);
  const deep = deepNested(500);
  const cases = [
    ['fileBlocks-500deep', () => updateWork(item, 'owner1', { note: 'x', files: [], now: T0 + 20 })], // placeholder replaced below
  ];
  // fileBlocks reaches claimedFilesOf via fileBlocksOf: entries {path, block}
  // where path is an object -> normalizeClaimPath rejects on typeof.
  expectClaimInputError('fileBlocks-500deep', () =>
    claimWork(createWork({ id: `fuzz09-d${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }),
      'owner1', { fileBlocks: deep, now: T0 + 20 }));
  // nested object where a string was required (note, evidenceRef)
  expectClaimInputError('note-500deep-object', () =>
    claimWork(createWork({ id: `fuzz09-dn${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' }),
      'owner1', { note: deep, now: T0 + 21 }));
  expectClaimInputError('evidenceRefs-500deep', () =>
    updateWork(item, 'owner1', { note: 'x', evidenceRefs: [deep], now: T0 + 22 }));
  // (premiseFlag is not a createWork param — unknown params are ignored by
  // destructuring; not tested here.)
  // 500-deep JSON round-trips without throwing (reachability sanity only)
  const { result: reparsed } = timed('JSON-500deep-roundtrip', () =>
    JSON.parse(JSON.stringify(deep)));
  assert.strictEqual(typeof reparsed, 'object');
  assertUntouched('deep-nesting', item, before);
  trackRss('deep-nesting');
  assert.strictEqual(cases.length, 1); // keeps the placeholder honest
});

// ---- O5: one op adds exactly one history stamp -----------------------------
test('O5: one op never grows history by more than one stamp', () => {
  // build an item already at the cap
  let work = createWork({ id: `fuzz09-h${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' });
  for (let i = 0; i < MAX_CLAIM_HISTORY; i++) {
    work = stampClaimHistory(work, 'owner1', { action: `act-${i}`, note: 'n'.repeat(4000), now: T0 + i });
  }
  assert.strictEqual(work.history.length, MAX_CLAIM_HISTORY);
  const beforeLen = claimHistoryLength(work);
  // worst case: a max-size (4000-char) note on an already-full history
  const { result: next, ms } = timed('stamp-at-cap-maxnote', () =>
    stampClaimHistory(work, 'owner1', { action: 'noted', note: 'z'.repeat(4000), now: T0 + 1_000_000 }));
  assert.strictEqual(claimHistoryLength(next), beforeLen + 1, 'one op must add exactly one lifetime entry');
  assert.strictEqual(next.history.length, MAX_CLAIM_HISTORY, 'cap holds after the op');
  // storage bound: MAX_CLAIM_HISTORY stamps x 4000-char notes is bounded
  const payloadBytes = JSON.stringify(next.history).length;
  assert.ok(payloadBytes < MAX_CLAIM_HISTORY * 4000 + 64 * 1024,
    `history payload ${payloadBytes} bytes exceeds the bounded maximum`);
  console.log(`[fuzz-09] full-cap history payload: ${(payloadBytes / 1024).toFixed(1)}KB (bound ${(MAX_CLAIM_HISTORY * 4000 / 1024).toFixed(1)}KB)`);
  trackRss('stamp-at-cap');
});

// ---- O6a: boardText (route-layer text guard) on hostile strings -----------
// boardText does NOT length-cap (the state machine does); it must stay linear
// on hostile input: NFC normalize + regexes, sub-second, no blowup.
test('O6a: boardText stays linear on 5MB / 1M-unicode notes, rejects unpaired surrogates', () => {
  for (const [label, payload] of [['5MB-ascii', bigAscii], ['500k-emoji', oneMEmoji], ['500k-e+combining', oneMCombining]]) {
    const { result, ms } = timed(`boardText-${label}`, () =>
      boardText(boardReject, 'note', payload, { multiline: true }));
    assert.strictEqual(typeof result, 'string');
    trackRss(`boardText-${label}`);
  }
  // lone surrogates are rejected with 422 invalid_claim_input (route layer)
  let err = null;
  try { boardText(boardReject, 'note', loneSurrogates, { multiline: true }); } catch (e) { err = e; }
  assert.ok(err, 'lone surrogates must be rejected');
  assert.strictEqual(err.status, 422);
  assert.strictEqual(err.code, 'invalid_claim_input');
  trackRss('boardText-surrogates');
});

// ---- O6b: route JSON body caps (code-verified — readText closed over) ------
// server/http.mjs: JSON_BODY_BYTES = 16384; body() -> readText(req, limit,
// actualBytes => new ServiceError(413, "too_large", ...)) — a declared or
// actual body over 16KiB is refused with 413 without buffering the excess
// (over-limit chunks are dropped while the socket drains to end).
// The Telegram/attachment routes use the larger mcpAttachmentBodyBytes.
// readText is not exported, so this is verified by code reading, not executed.
test('O6b: HTTP body cap contract (code-verified)', () => {
  const src = readFileSync(
    new URL('../server/http.mjs', import.meta.url), 'utf8');
  assert.ok(/const JSON_BODY_BYTES = 16384/.test(src), 'JSON_BODY_BYTES must be 16384');
  assert.ok(/new ServiceError\(413, "too_large"/.test(src), 'over-limit bodies must map to 413');
  assert.ok(/bytes \+= chunk\.length;[\s\S]{0,200}oversize = true; chunks\.length = 0/.test(src),
    'over-limit chunks must be dropped (not buffered) while counting');
});

// ---- O7: event bodies stay bounded -----------------------------------------
test('O7: workClaimEventData with max-size claim fields stays bounded and fast', () => {
  // a claim at every field cap: 512-char title, 64 file paths, 16 PRs
  let work = createWork({
    id: `fuzz09-e${claimSeq++}`, title: 'T'.repeat(512),
    files: Array.from({ length: 64 }, (_, i) => `dir/file${i}.js`),
    pullRequests: Array.from({ length: 16 }, (_, i) => `https://github.com/a/b/pull/${i + 1}`),
  }, { now: T0, agentId: 'owner1' });
  work = claimWork(work, 'owner1', { note: 'n'.repeat(4000), now: T0 + 1 });
  const { result: data, ms } = timed('workClaimEventData-maxclaim', () =>
    workClaimEventData(work, 'state_changed', { reason: 'r'.repeat(4000) }));
  const bytes = JSON.stringify(data).length;
  assert.ok(bytes < 128 * 1024, `event data ${bytes} bytes — should be a thin pointer, not the payload`);
  assert.strictEqual(data.title, 'T'.repeat(512));
  assert.strictEqual(data.paths.length, 64);
  trackRss('workClaimEventData');
});

// ---- randomized sweep: fuzz-y note lengths x ops --------------------------
test('O8: randomized note-length sweep across ops (seeded)', () => {
  const lens = [0, 1, 511, 512, 513, 1999, 2000, 2001, 3999, 4000, 4001, 8192, 100_000, FIVE_MB];
  const alphabet = 'abcdefghijklmnopqrstuvwxyzé🔥\u0301';
  const rstr = (len) => {
    let s = '';
    while (s.length < len) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };
  let accepted = 0, rejected = 0, msMax = 0;
  for (let i = 0; i < 60; i++) {
    const len = lens[Math.floor(rand() * lens.length)];
    const note = rstr(len);
    const base = createWork({ id: `fuzz09-s${claimSeq++}`, title: 't' }, { now: T0, agentId: 'owner1' });
    const t0 = performance.now();
    try { claimWork(base, 'owner1', { note, now: T0 + 1 }); accepted++; }
    catch (e) {
      assert.ok(e instanceof ClaimError, `seeded sweep: note len ${len} threw ${e?.constructor?.name} — 500 risk`);
      rejected++;
    }
    const ms = performance.now() - t0;
    if (ms > msMax) msMax = ms;
    assert.ok(ms < 1000, `seeded sweep: note len ${len} took ${ms.toFixed(0)}ms`);
  }
  console.log(`[fuzz-09] seeded sweep: ${accepted} accepted, ${rejected} rejected, max op ${msMax.toFixed(1)}ms`);
  trackRss('seeded-sweep');
});

test('O9 battery report: peak RSS', () => {
  trackRss('final');
  console.log(`[fuzz-09] peak RSS: ${peakRssMB.toFixed(1)}MB (budget 1024MB)`);
  assert.ok(peakRssMB < 1024, `peak RSS ${peakRssMB.toFixed(1)}MB exceeded 1GB`);
});
