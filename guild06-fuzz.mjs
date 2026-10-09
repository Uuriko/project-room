#!/usr/bin/env node
// GUILD-06 fuzz harness: adversarial CLI battery against scripts/ slice.
// Usage: node guild06-fuzz.mjs [--script <name>] [--out results.jsonl]
// Runs each script with: no args, --help, bogus flag, nonexistent file,
// directory-as-file, empty arg. Flags uncaught-exception stack traces.
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = join(ROOT, 'scripts');
const slice = readFileSync(join(ROOT, 'guild-script-slice.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);

const SKIP_EXEC = new Set([
  ...slice.filter(s => s.endsWith('-browser-check.mjs')),
  'deploy-live.py', 'install.sh', 'rotation-cutover.sh', 'rotation-rehearse.sh', 'test-env.sh',
]);
// statically skip: browser automation (playwright/chromium), node:test suites
// (not CLI scripts), prod-network probes (trydemigod), deployment tooling.
function skipReason(src) {
  if (src.includes('trydemigod')) return 'prod-network';
  if (/from ["']playwright["']|chromium\.launch|puppeteer/.test(src)) return 'browser';
  if (/from ["']node:test["']/.test(src)) return 'node-test';
  return null;
}
const trydemigod = new Set();
const skippedStatic = [];
const SUBDIRS = ['exchange', 'helpers', 'onboarding-probe', 'qa2', 'qa3', 'room-digest', 'schema-gate', 'vendor-licenses', 'visual-regression-baselines'];
const { readdirSync, statSync } = await import('node:fs');
const subScripts = [];
for (const d of SUBDIRS) {
  const subdir = join(SCRIPTS, d);
  if (!existsSync(subdir) || !statSync(subdir).isDirectory()) continue;
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e); const r = join(rel, e);
      if (statSync(full).isDirectory()) { if (e !== 'node_modules') walk(full, r); }
      else if (e.endsWith('.mjs') && !e.endsWith('-browser-check.mjs')) subScripts.push(r);
    }
  };
  walk(subdir, d);
}
const skipSet = new Map(); // script -> reason
for (const s of subScripts) {
  try {
    const c = readFileSync(join(SCRIPTS, s), 'utf8');
    const r = skipReason(c);
    if (r) skipSet.set(s, r);
  } catch {}
}
const topTargets = [];
for (const s of slice) {
  if (!s.endsWith('.mjs') || SKIP_EXEC.has(s)) continue;
  try {
    const r = skipReason(readFileSync(join(SCRIPTS, s), 'utf8'));
    if (r) { skipSet.set(s, r); continue; }
  } catch {}
  topTargets.push(s);
}

const BATTERY = [
  { name: 'no-args', args: [] },
  { name: 'help', args: ['--help'] },
  { name: 'bogus-flag', args: ['--definitely-not-a-real-flag-xyz'] },
  { name: 'missing-file', args: ['/nonexistent-guild06-fuzz-xyz-123'] },
  { name: 'dir-as-file', args: ['/tmp'] },
  { name: 'empty-arg', args: [''] },
];

const only = process.argv.includes('--script') ? process.argv[process.argv.indexOf('--script') + 1] : null;
const outPath = join(ROOT, '.fuzz-results.jsonl');
const targets = only ? [only] : [
  ...topTargets,
  ...subScripts.filter(s => !skipSet.has(s)),
];

function stackTrace(stderr) {
  const lines = stderr.split('\n');
  const frames = lines.filter(l => /^\s*at\s/.test(l) || /node:internal/.test(l));
  return frames.length > 0 ? frames.slice(0, 8).join('\n') : null;
}

const results = [];
for (const s of targets) {
  const p = join(SCRIPTS, s);
  if (!existsSync(p)) { results.push({ script: s, status: 'missing' }); continue; }
  const chk = spawnSync(process.execPath, ['--check', p], { timeout: 15000 });
  if (chk.status !== 0) { results.push({ script: s, status: 'syntax-error', stderr: chk.stderr.toString().slice(0, 500) }); continue; }
  const cases = [];
  for (const b of BATTERY) {
    const r = spawnSync(process.execPath, [p, ...b.args], {
      timeout: 20000, cwd: ROOT,
      env: { ...process.env, TMPDIR: join(ROOT, '.tmp'), NO_COLOR: '1' },
    });
    const stderr = (r.stderr || Buffer.alloc(0)).toString();
    const stdout = (r.stdout || Buffer.alloc(0)).toString();
    const st = stackTrace(stderr);
    cases.push({
      case: b.name, status: r.status, signal: r.signal,
      timedOut: r.error && r.error.code === 'ETIMEDOUT',
      stdoutLen: stdout.length, stderrLen: stderr.length,
      stack: st,
      stderrHead: st ? null : stderr.slice(0, 300),
    });
  }
  const crashes = cases.filter(c => c.stack);
  const rec = { script: s, status: crashes.length ? 'CRASH' : 'ok', crashes: crashes.map(c => ({ case: c.case, status: c.status, stack: c.stack })) };
  results.push(rec);
  appendFileSync(outPath, JSON.stringify(rec) + '\n'); // incremental: kill-safe
  if (crashes.length) console.log('CRASH:', s, crashes.map(c => c.case).join(','));
}
const crashCount = results.filter(r => r.status === 'CRASH').length;
console.log(`done: ${results.length} scripts, ${crashCount} crashed, ${results.filter(r => r.status === 'syntax-error').length} syntax errors`);
console.log(`static skips: ${skipSet.size}`, JSON.stringify([...skipSet.entries()].reduce((a, [k, v]) => { a[v] = (a[v] || 0) + 1; return a; }, {})));
