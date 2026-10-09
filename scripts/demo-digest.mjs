#!/usr/bin/env node
/**
 * demo-digest.mjs — 25-synthetic-receipt demo for build-digest.mjs.
 *
 * Generates 25 deterministic synthetic worker receipts (mixed
 * completed/errored/blocked) into .tmp/digest-demo/receipts/, runs the
 * digest builder, writes .tmp/digest-demo/DIGEST.md, and reports:
 *   - digest bytes vs receipt bytes (compression ratio)
 *   - estimated reading time saved at 200 wpm
 *
 * Deterministic: seeded PRNG, so re-runs produce byte-identical output.
 * Not committed (lives under gitignored .tmp/).
 *
 * Usage: node scripts/demo-digest.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadReceipts,
  buildDigest,
  byteStats,
} from './build-digest.mjs';

const OUT = new URL('../.tmp/digest-demo/', import.meta.url).pathname;

// mulberry32 — deterministic PRNG
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(5001225);

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (n) => Math.floor(rand() * n);

const TASKS = [
  'Add contrast-pair acceptance tests for dark theme panels',
  'Document the claim-bond shadow CLI flags in the coordinator README',
  'Fix flaky inbox-outbox test under parallel sqlite writes',
  'Refactor room-export pagination to cursor-based pages',
  'Add security audit for the batch-dispatch endpoint',
  'Migrate legacy room-state branch notes to the new format',
  'Write perf budget checks for the join flow',
  'Harden the partition-check dry-run against stale boards',
  'Add docs for the new agent-card signature hint endpoint',
  'Fix broken retry backoff in the room-guard client',
  'Add accessibility labels to the board filter controls',
  'Implement the receipts-page empty-state copy pass',
  'Benchmark claim-board sweep at 500 concurrent lanes',
  'Fix double-posted DONE events in the event log writer',
  'Add feature flag gating for the experimental replay harness',
  'Document coordinator-loop usage of the digest builder',
  'Triage the 7 adversarial QA-200 findings for the burn-down',
  'Fix the merge-queue dry-run false positive on renamed files',
  'Add unit tests for the writer-fence additive table registry',
  'Instrument the live-smoke probe with timing breakdowns',
  'Write the chaos harness seed corpus for inbox recovery',
  'Fix CSP violation on the join-loader iframe embed',
  'Add rate-limit headers to the public agent-card endpoint',
  'Refactor the room roster snapshot to incremental diffs',
  'Document the room health check thresholds for operators',
];

const FILES = [
  'scripts/contrast-check.mjs', 'docs/COORDINATOR.md', 'tests/inbox-outbox.test.js',
  'server/room-export.mjs', 'docs/OPENAPI.md', 'scripts/perf-budget.mjs',
  'scripts/partition-check.mjs', 'docs/AGENT-CARD.md', 'client/room-guard.js',
  'client/board-filters.js', 'server/receipts-page.mjs', 'chaos/corpus.json',
];

const ERRORS = [
  'ECONNRESET: room API dropped the connection mid-post',
  'AssertionError: expected 3 claims, board shows 2 (stale read?)',
  'Timeout after 60s waiting for CI check suite on PR #2099',
  'EACCES: token lacks scope to push to the lane branch',
  'Out of memory: fuzz corpus exceeded 512MB tmpfs budget',
];

const BLOCKERS = [
  'waiting on owner review of the schema change',
  'needs signing-key tap from John before deploy smoke test',
  'blocked on worker 14\'s partition-plan output',
  'waiting for CI queue to drain (14 jobs ahead)',
  'needs credentials for the staging Cloudflare account',
];

const QUESTIONS = [
  'Should the digest cap per-worker lines at one, or allow two for errored workers?',
  'Do we count docs-only changes toward the significance score?',
  'Is 500 chars the right roll-up limit for room posts, or should it match the room\'s actual cap?',
  'Should failing tests on a completed receipt move it to the attention section?',
  'Confirm the v1 receipt schema field name: tokensUsed or tokens_used?',
];

const VERIFY = [
  'Verified by re-running the affected test file twice plus the full unit shard for the touched module.',
  'Verified against a fresh checkout: clean npm test on the touched suite, plus a manual walkthrough of the happy path.',
  'Confirmed via the repo\'s own check script; no unrelated files were touched.',
  'Cross-checked with a second read of the live board before claiming the follow-up.',
];

function makeReceipt(i) {
  const workerId = `worker-${String(i + 1).padStart(2, '0')}`;
  const roll = rand();
  const status = roll < 0.68 ? 'completed' : roll < 0.88 ? 'errored' : 'blocked';
  const task = TASKS[i];
  const files = [...new Set(Array.from({ length: 1 + int(6) }, () => pick(FILES)))];
  const testsPassed = 4 + int(20);
  const testsFailed = status === 'completed' && rand() < 0.2 ? 1 + int(3) : 0;
  const detail = `Touched ${files.length} file${files.length === 1 ? '' : 's'} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}). ${pick(VERIFY)}`;
  const r = {
    version: '1',
    workerId,
    status,
    summary: status === 'completed'
      ? `${task}. ${detail} Main risk was overlap with a sibling lane's uncommitted work; avoided by checking the live claims board first.`
      : status === 'errored'
        ? `${task}. Implementation was about two-thirds done when the run failed; partial changes were kept in the lane worktree and NOT committed. ${detail}`
        : `${task}. Paused early (before writing any code) once the external dependency became clear; nothing to roll back.`,
    filesChanged: files,
    tests: { passed: testsPassed, failed: testsFailed, total: testsPassed + testsFailed },
    durationMs: 60_000 + int(1_800_000),
    tokensUsed: 20_000 + int(120_000),
    completedAt: '2026-10-08T19:00:00-07:00',
  };
  if (status === 'completed' && rand() < 0.3) {
    r.openQuestions = [pick(QUESTIONS)];
  }
  if (status === 'errored') {
    r.error = pick(ERRORS);
    if (rand() < 0.7) r.openQuestions = [pick(QUESTIONS)];
  }
  if (status === 'blocked') {
    r.blockers = [pick(BLOCKERS)];
    r.openQuestions = [pick(QUESTIONS), pick(QUESTIONS)].filter((v, idx, a) => a.indexOf(v) === idx);
  }
  if (status === 'completed' && rand() < 0.25) {
    r.blockersResolved = ['stale board read resolved by re-fetch before writing'];
  }
  return r;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  const receiptsDir = join(OUT, 'receipts');
  mkdirSync(receiptsDir, { recursive: true });

  for (let i = 0; i < 25; i++) {
    writeFileSync(join(receiptsDir, `worker-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify(makeReceipt(i), null, 2) + '\n');
  }

  const { receipts, skipped } = loadReceipts(receiptsDir);
  const run1 = buildDigest(receipts, skipped, receiptsDir);
  const run2 = buildDigest(receipts, skipped, receiptsDir);
  if (run1.digest !== run2.digest) {
    console.error('FAIL: digest is not deterministic across runs');
    process.exit(1);
  }

  writeFileSync(join(OUT, 'DIGEST.md'), run1.digest + '\n');
  const stats = byteStats(receiptsDir, run1.digest);

  // invariants
  const checks = [
    ['25 receipts loaded', receipts.length === 25],
    ['all worker ids appear in digest', receipts.every((r) => run1.digest.includes(r.workerId))],
    ['roll-up ≤ 500 chars', run1.rollup.length <= 500],
    ['digest byte-identical across runs', run1.digest === run2.digest],
    ['attention section non-empty', run1.digest.includes('Needs attention')],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }

  console.log('\n--- digest ---\n');
  console.log(run1.digest);
  console.log('\n--- compression ---');
  console.log(`receipt bytes : ${stats.receiptBytes}`);
  console.log(`digest bytes  : ${stats.digestBytes}`);
  console.log(`ratio         : ${stats.compressionRatio.toFixed(2)}x`);
  console.log(`read time all : ${stats.receiptReadMin.toFixed(1)} min @200wpm`);
  console.log(`read time one : ${stats.digestReadMin.toFixed(1)} min @200wpm`);
  console.log(`minutes saved : ${stats.minutesSaved.toFixed(1)} per 25-worker wave`);
  console.log(`\ndigest written to ${join(OUT, 'DIGEST.md')}`);
  if (!ok) process.exit(1);
}

main();
