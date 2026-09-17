import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// scripts/measure-cold-start.mjs folds two measurements into one CLI (PR #141's
// constructor-against-N-events and PR #160's per-phase first request). These
// tests pin the CLI surface and the JSON shapes both subcommands report; they use
// tiny runs so the suite does not pay for a real measurement.
const script = fileURLToPath(new URL('../scripts/measure-cold-start.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const numbers = (object, keys) => { for (const key of keys) assert.equal(typeof object[key], 'number', `${key} is a number`); };

test('phases subcommand (the default) reports median CPU and wall per phase and honours --no-miniflare', () => {
  const result = run('1', '--json', '--no-miniflare');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.node, process.version);
  assert.deepEqual([report.runs, report.statistic, report.miniflare], [1, 'median', 'skipped (--no-miniflare)']);
  assert.deepEqual(report.rows.map(row => row.phase), [
    'import server/store.mjs + server/http.mjs', 'fresh store: constructor + initialize', 'listen + first GET /api/health',
    'first authenticated GET /api/rooms/commons', 'reopen existing store (constructor only)']);
  for (const row of report.rows) { assert.equal(row.runtime, `Node ${process.version}`); numbers(row, ['cpuMs', 'wallMs']); }
  const explicit = run('phases', '1', '--no-miniflare');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /^Cold-start measurement, median of 1 run \(CPU/);
  assert.match(explicit.stdout, /miniflare: skipped \(--no-miniflare\)/);
});

test('constructor subcommand fills N events, times cold constructions and keeps the #141 report shape', () => {
  const result = run('constructor', '40', '2', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.node, report.events, report.helpHistory, report.runs], [process.version, 40, false, 2]);
  numbers(report, ['buildMs']);
  for (const key of ['constructorMs', 'constructorCpuMs']) {
    numbers(report[key], ['min', 'median', 'max']);
    assert.equal(report[key].samples.length, 2);
    assert.ok(report[key].min <= report[key].median && report[key].median <= report[key].max, `${key} ordered`);
  }
  assert.match(report.note, /workerd CPU accounting differs/);
  const help = run('constructor', '40', '1', '--help-history', '--json');
  assert.equal(help.status, 0, help.stderr);
  const withHelp = JSON.parse(help.stdout);
  assert.deepEqual([withHelp.events, withHelp.helpHistory, withHelp.runs, withHelp.constructorMs.samples.length], [40, true, 1, 1]);
  const table = run('constructor', '40', '1');
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^Cold-start constructor measurement, 1 cold construction of a 40-event store \(Node/);
  assert.match(table.stdout, /RoomStore constructor\s+min\s+median\s+max/);
});

test('usage errors exit 2 without measuring', () => {
  for (const args of [['constructor', '1'], ['constructor', '40', '0'], ['--bogus'], ['constructor', '--no-miniflare'], ['phases', '--help-history'], ['0'], ['2', '3']]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(' ')} exits 2`);
    assert.match(result.stderr, /^Usage: node scripts\/measure-cold-start\.mjs/);
    assert.equal(result.stdout, '');
  }
});
