// Contract: the flaky detector flags tests whose pass/fail outcome varies
// across repeated runs, and stays silent on stable tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFlaky } from '../scripts/flaky-detect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'flaky-detect');
const script = path.join(here, '..', 'scripts', 'flaky-detect.mjs');

function freshMarker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-detect-marker-'));
  return path.join(dir, 'counter');
}

test('detector flags the alternating fixture as flaky', async () => {
  const marker = freshMarker();
  const result = await detectFlaky(path.join(fixtures, 'flaky.fixture.mjs'), {
    runs: 4,
    timeout: 60_000,
    env: { ...process.env, FLAKY_DETECT_MARKER: marker },
  });
  const names = result.flaky.map((f) => f.name);
  assert.ok(
    names.some((n) => n.includes('alternating test (flaky by design)')),
    `expected alternating test flagged flaky, got: ${JSON.stringify(names)}`,
  );
  assert.equal(result.exitCode, 1);
});

test('detector does NOT flag the stable fixture', async () => {
  const result = await detectFlaky(path.join(fixtures, 'stable.fixture.mjs'), {
    runs: 4,
    timeout: 60_000,
  });
  assert.deepEqual(result.flaky, []);
  assert.equal(result.exitCode, 0);
});

test('detector isolates flaky tests in a mixed file', async () => {
  const marker = freshMarker();
  const result = await detectFlaky(path.join(fixtures, 'flaky.fixture.mjs'), {
    runs: 4,
    timeout: 60_000,
    env: { ...process.env, FLAKY_DETECT_MARKER: marker },
  });
  const names = result.flaky.map((f) => f.name);
  assert.ok(
    names.every((n) => !n.includes('always stable test (never flaky)')),
    `stable test wrongly flagged: ${JSON.stringify(names)}`,
  );
  assert.equal(result.flaky.length, 1);
  const [f] = result.flaky;
  assert.equal(f.passes + f.fails, 4);
  assert.ok(f.passes > 0 && f.fails > 0);
});

test('detector reports a missing file instead of crashing', async () => {
  const result = await detectFlaky(path.join(fixtures, 'no-such-file.mjs'), { runs: 2 });
  assert.ok(result.error, 'expected an error for a missing file');
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.flaky, []);
});

test('detector keeps same-named subtests under different parents separate', async () => {
  // nested.fixture.mjs: parent A has an always-passing subtest, parent B an
  // alternating one, both named "same name subtest". The old flat key
  // (indent + number + name) merged them into one record, misreporting the
  // stable subtest as flaky and hiding the real culprit's parent.
  const marker = freshMarker();
  const result = await detectFlaky(path.join(fixtures, 'nested.fixture.mjs'), {
    runs: 4,
    timeout: 60_000,
    env: { ...process.env, FLAKY_DETECT_MARKER: marker },
  });
  const names = result.flaky.map((f) => f.name);
  assert.ok(
    names.includes('parent B > 1 - same name subtest'),
    `expected parent B's subtest flagged with its full TAP path, got: ${JSON.stringify(names)}`,
  );
  assert.ok(
    names.every((n) => !n.includes('parent A > 1 - same name subtest')),
    `stable subtest wrongly flagged: ${JSON.stringify(names)}`,
  );
  assert.equal(result.exitCode, 1);
});

test('cli: contradictory run counts are rejected, not silently overridden', () => {
  // A nonexistent target keeps this at the parseArgs boundary (fast: no runs).
  for (const args of [['no-such-file.mjs', '--runs=5', '7'], ['no-such-file.mjs', '5', '7'], ['no-such-file.mjs', '5x']]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `expected exit 2 for args ${args.join(' ')}, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /unexpected argument/, `expected "unexpected argument" for ${args.join(' ')}: ${r.stderr}`);
  }
});

test('cli: non-numeric timeout is rejected', () => {
  const r = spawnSync(process.execPath, [script, 'no-such-file.mjs', '--timeout=abc'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /timeout must be a positive integer/, `unexpected stderr: ${r.stderr}`);
});
