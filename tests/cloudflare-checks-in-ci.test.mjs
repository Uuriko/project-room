// Every Worker check either runs in CI (cloudflare npm test or test:browser)
// or is named in a shrink-only baseline. Found 2026-11-04: 55 checks were
// syntax-checked but never executed, and some had gone stale unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('cloudflare/package.json', root), 'utf8'));
const listed = new Set(['test', 'test:browser'].flatMap(name => (pkg.scripts[name] ?? '').split(/\s+/)).filter(file => file.endsWith('.check.mjs')));
const baseline = new Set(JSON.parse(readFileSync(new URL('scripts/cloudflare-unrun-checks.json', root), 'utf8')).files);
const onDisk = readdirSync(new URL('cloudflare/', root)).filter(name => name.endsWith('.check.mjs'));
test('no new Worker check is left out of CI', () => {
  const missing = onDisk.filter(name => !listed.has(name) && !baseline.has(name));
  assert.deepEqual(missing, [], 'add these to cloudflare/package.json scripts.test: ' + missing.join(', '));
});
test('the not-in-CI baseline only shrinks', () => {
  const stale = [...baseline].filter(name => listed.has(name) || !onDisk.includes(name));
  assert.deepEqual(stale, [], 'remove these from scripts/cloudflare-unrun-checks.json: ' + stale.join(', '));
});
