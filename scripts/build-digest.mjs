#!/usr/bin/env node
/**
 * build-digest.mjs — coordinator digest builder (WAVE-500 coord-cost, worker 12/17).
 *
 * A coordinator with 25 workers gets 25 completion reports; reading them all
 * is ~37% of the coordinator's wave time. This tool collapses N structured
 * receipts into one ranked 60-second digest.
 *
 * Input: a directory of worker receipt JSON files. Accepts worker 6's v1
 * receipt schema or the minimal fallback:
 *   { workerId, status, summary, filesChanged, tests }
 * plus any of: openQuestions, blockers, blockersResolved, error,
 * durationMs, tokensUsed, startedAt, completedAt.
 *
 * Output: a ranked markdown digest with
 *   (a) headline counts
 *   (b) completions ranked by significance, one line each
 *   (c) errored/blocked receipts with openQuestions quoted verbatim
 *   (d) aggregate metrics
 *   (e) a ≤500-char roll-up suitable for a single room DONE post
 *
 * Ranking is fully deterministic (no LLM calls): score desc, then workerId
 * asc as tie-break, so identical inputs always produce byte-identical output.
 *
 * Usage:
 *   node scripts/build-digest.mjs --input <receipts-dir> [--out digest.md] [--json stats.json]
 *
 * Exit codes: 0 = ok, 2 = input dir missing/empty or no parseable receipts.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Receipt normalization (tolerant: v1 schema or minimal fallback)
// ---------------------------------------------------------------------------

const STATUS_MAP = {
  completed: 'completed', done: 'completed', success: 'completed', ok: 'completed',
  errored: 'errored', failed: 'errored', fail: 'errored',
  blocked: 'blocked', waiting: 'blocked', stuck: 'blocked',
};

export function normalizeStatus(raw) {
  if (typeof raw !== 'string') return 'unknown';
  return STATUS_MAP[raw.trim().toLowerCase()] ?? 'unknown';
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim().length > 0);
}

export function parseTests(r) {
  // Accept {passed,failed}, flat testsPassed/testsFailed, or "12/2" strings.
  if (r.tests && typeof r.tests === 'object') {
    return { passed: asNumber(r.tests.passed ?? r.tests.testsPassed), failed: asNumber(r.tests.failed ?? r.tests.testsFailed) };
  }
  if (typeof r.tests === 'string') {
    const m = r.tests.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { passed: asNumber(m[1]), failed: asNumber(m[2]) - asNumber(m[1]) >= 0 ? asNumber(m[2]) - asNumber(m[1]) : 0 };
  }
  const passed = asNumber(r.testsPassed ?? r.passedTests);
  const failed = asNumber(r.testsFailed ?? r.failedTests);
  const total = asNumber(r.totalTests);
  return { passed, failed: failed || (total > passed ? total - passed : 0) };
}

export function normalizeReceipt(raw, fileName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw.receipt && typeof raw.receipt === 'object' ? raw.receipt : raw; // tolerate envelope wrapper
  const workerId = String(r.workerId ?? r.worker_id ?? r.id ?? basename(fileName, '.json')).trim() || 'unknown';
  const status = normalizeStatus(r.status ?? r.state);
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, 2000)
    : typeof r.result === 'string' ? r.result.trim().slice(0, 2000) : '';
  const fc = r.filesChanged ?? r.files_changed ?? r.files;
  const filesChanged = Array.isArray(fc) ? fc.filter((x) => typeof x === 'string') : [];
  const fileCount = Array.isArray(fc) ? filesChanged.length : asNumber(fc);
  return {
    workerId,
    status,
    summary,
    fileCount,
    filesChanged,
    tests: parseTests(r),
    openQuestions: asStringArray(r.openQuestions ?? r.open_questions ?? r.questions),
    blockers: asStringArray(r.blockers ?? r.blockedBy),
    blockersResolved: asStringArray(r.blockersResolved ?? r.blockers_resolved ?? r.unblocked),
    error: typeof r.error === 'string' ? r.error.trim().slice(0, 1000) : '',
    durationMs: asNumber(r.durationMs ?? r.duration_ms),
    tokensUsed: asNumber(r.tokensUsed ?? r.tokens_used),
    fileName: basename(fileName),
  };
}

export function loadReceipts(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const receipts = [];
  const skipped = [];
  for (const f of files) {
    const p = join(dir, f);
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const n = normalizeReceipt(raw, f);
      if (n) receipts.push(n);
      else skipped.push(f);
    } catch {
      skipped.push(f);
    }
  }
  return { receipts, skipped };
}

// ---------------------------------------------------------------------------
// Deterministic significance ranking (completions)
// ---------------------------------------------------------------------------

const KEYWORD_WEIGHTS = [
  ['security', 25],
  ['breaking', 20],
  ['deploy', 15],
  ['bug', 10],
  ['feature', 10],
  ['perf', 8],
  ['refactor', 5],
  ['docs', 5],
  ['test', 3],
];

export function scoreCompletion(n) {
  let score = 100; // base: finished work
  score += 10 * Math.min(n.fileCount, 10);
  const ran = n.tests.passed + n.tests.failed;
  if (ran > 0 && n.tests.failed === 0) score += 20; // green tests
  if (n.tests.failed > 0) score += 40;              // failing tests = needs coordinator eyes
  const hay = n.summary.toLowerCase();
  for (const [kw, w] of KEYWORD_WEIGHTS) {
    if (hay.includes(kw)) score += w;
  }
  if (n.blockersResolved.length > 0) score += 15;
  return score;
}

function compareCompletions(a, b) {
  const d = scoreCompletion(b) - scoreCompletion(a);
  if (d !== 0) return d;
  return a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0;
}

function compareAttention(a, b) {
  const ua = a.openQuestions.length + a.blockers.length;
  const ub = b.openQuestions.length + b.blockers.length;
  if (ub !== ua) return ub - ua;
  return a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Digest rendering
// ---------------------------------------------------------------------------

function oneLine(s, max = 160) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

function fmtTests(t) {
  const ran = t.passed + t.failed;
  if (ran === 0) return 'no tests reported';
  return `${t.passed}/${ran} tests passed`;
}

function completionLine(n) {
  return `[${n.workerId}] ${oneLine(n.summary || '(no summary)', 120)} — ${n.fileCount} file${n.fileCount === 1 ? '' : 's'}, ${fmtTests(n.tests)}`;
}

export function buildRollup(sections, limit = 500) {
  const top = sections.completions.slice(0, 3).map((n) => `[${n.workerId}] ${oneLine(n.summary || 'done', 48)}`);
  const attention = sections.attention.slice(0, 3).map((n) => {
    const tag = n.status === 'errored' ? 'err' : 'blocked';
    const q = n.openQuestions.length ? ` (${n.openQuestions.length} Q)` : '';
    return `${n.workerId} ${tag}${q}`;
  });
  let rollup = `DONE digest: ${sections.total} receipts (${sections.completed} ok / ${sections.errored} err / ${sections.blocked} blocked).`;
  if (top.length) rollup += ` Top: ${top.join('; ')}.`;
  if (attention.length) rollup += ` Attention: ${attention.join(', ')}.`;
  rollup += ` Tests ${sections.testsPassed}/${sections.testsPassed + sections.testsFailed} pass.`;
  if (rollup.length > limit) rollup = rollup.slice(0, limit - 1) + '…';
  return rollup;
}

export function buildDigest(receipts, skipped, receiptBytes) {
  const completed = receipts.filter((r) => r.status === 'completed').sort(compareCompletions);
  const attention = receipts.filter((r) => r.status === 'errored' || r.status === 'blocked').sort(compareAttention);
  const unknown = receipts.filter((r) => r.status === 'unknown');
  const testsPassed = receipts.reduce((s, r) => s + r.tests.passed, 0);
  const testsFailed = receipts.reduce((s, r) => s + r.tests.failed, 0);
  const filesTotal = receipts.reduce((s, r) => s + r.fileCount, 0);
  const tokensTotal = receipts.reduce((s, r) => s + r.tokensUsed, 0);
  const tokensKnown = receipts.filter((r) => r.tokensUsed > 0).length;
  const durTotal = receipts.reduce((s, r) => s + r.durationMs, 0);
  const durKnown = receipts.filter((r) => r.durationMs > 0).length;
  const withQuestions = receipts.filter((r) => r.openQuestions.length > 0).length;

  const total = receipts.length;
  const pct = total ? Math.round((100 * completed.length) / total) : 0;
  const sections = {
    total, completed: completed.length, errored: receipts.filter((r) => r.status === 'errored').length,
    blocked: receipts.filter((r) => r.status === 'blocked').length, completions: completed,
    attention, testsPassed, testsFailed,
  };
  const rollup = buildRollup(sections);

  const L = [];
  L.push(`# Coordinator digest — ${total} worker receipts`);
  L.push('');
  L.push('## Headline');
  L.push(`- ${total} receipts: ${sections.completed} completed, ${sections.errored} errored, ${sections.blocked} blocked (${pct}% completion)`);
  if (unknown.length) L.push(`- ${unknown.length} unparseable/unknown-status receipts (${unknown.map((r) => r.workerId).join(', ')})`);
  if (skipped.length) L.push(`- ${skipped.length} files skipped (not valid JSON): ${skipped.join(', ')}`);
  L.push('');
  L.push('## Completions (ranked by significance)');
  if (!completed.length) L.push('- _none_');
  completed.forEach((n, i) => L.push(`${i + 1}. ${completionLine(n)}`));
  L.push('');
  L.push('## Needs attention: errored / blocked');
  if (!attention.length) L.push('- _none — clean wave_');
  for (const n of attention) {
    L.push(`- **[${n.workerId}] ${n.status.toUpperCase()}**: ${oneLine(n.summary || n.error || '(no summary)', 140)}`);
    if (n.error && n.status === 'errored' && n.error !== n.summary) L.push(`  - error: ${oneLine(n.error, 140)}`);
    for (const b of n.blockers) L.push(`  - blocked by: ${oneLine(b, 140)}`);
    for (const q of n.openQuestions) L.push(`  - open question: ${q}`); // verbatim
  }
  L.push('');
  L.push('## Aggregate metrics');
  L.push(`- workers reporting: ${total}`);
  L.push(`- files changed: ${filesTotal}`);
  L.push(`- tests: ${testsPassed} passed / ${testsFailed} failed across ${testsPassed + testsFailed} reported`);
  if (tokensKnown) L.push(`- tokens used: ${tokensTotal.toLocaleString('en-US')} (reported by ${tokensKnown}/${total})`);
  if (durKnown) L.push(`- total worker time: ${(durTotal / 1000).toFixed(1)}s across ${durKnown} reporters (avg ${(durTotal / durKnown / 1000).toFixed(1)}s)`);
  L.push(`- receipts with open questions: ${withQuestions}`);
  L.push('');
  L.push('## Room roll-up (post as single DONE)');
  L.push('```');
  L.push(rollup);
  L.push('```');
  L.push(`_roll-up length: ${rollup.length}/500 chars_`);
  L.push('');
  const digest = L.join('\n');
  return { digest, rollup, stats: { total, pct, testsPassed, testsFailed, filesTotal } };
}

export function byteStats(receiptDir, digestText) {
  const files = readdirSync(receiptDir).filter((f) => f.endsWith('.json'));
  const receiptBytes = files.reduce((s, f) => s + statSync(join(receiptDir, f)).size, 0);
  const digestBytes = Buffer.byteLength(digestText, 'utf8');
  const words = (b) => b / 5; // ~5 bytes per word incl. whitespace
  const receiptMin = words(receiptBytes) / 200;
  const digestMin = words(digestBytes) / 200;
  return {
    receiptBytes,
    digestBytes,
    compressionRatio: receiptBytes / Math.max(digestBytes, 1),
    receiptReadMin: receiptMin,
    digestReadMin: digestMin,
    minutesSaved: receiptMin - digestMin,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { input: null, out: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) args.input = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === '--json' && argv[i + 1]) args.json = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log('Usage: node scripts/build-digest.mjs --input <receipts-dir> [--out digest.md] [--json stats.json]');
    process.exit(args.help ? 0 : 2);
  }
  let dirStat;
  try {
    dirStat = statSync(args.input);
  } catch {
    console.error(`error: input dir not found: ${args.input}`);
    process.exit(2);
  }
  if (!dirStat.isDirectory()) {
    console.error(`error: not a directory: ${args.input}`);
    process.exit(2);
  }
  const { receipts, skipped } = loadReceipts(args.input);
  if (!receipts.length) {
    console.error('error: no parseable receipt JSONs in input dir');
    process.exit(2);
  }
  const { digest, rollup, stats } = buildDigest(receipts, skipped, args.input);
  const byte = byteStats(args.input, digest);
  if (args.out) writeFileSync(args.out, digest + '\n');
  else process.stdout.write(digest + '\n');
  const report = { ...byte, ...stats, receipts: receipts.length, rollupChars: rollup.length };
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify(report));
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) main();
