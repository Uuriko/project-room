// Contract: the flaky detector flags tests whose pass/fail outcome varies
// across repeated runs, and stays silent on stable tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFlaky } from '../scripts/flaky-detect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'flaky-detect');

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
