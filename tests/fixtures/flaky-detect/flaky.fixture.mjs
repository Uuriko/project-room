// Alternating fixture: DETERMINISTIC flakiness. Passes on odd invocations,
// fails on even ones, via a counter file shared across the detector's runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const marker = process.env.FLAKY_DETECT_MARKER
  || path.join(os.tmpdir(), 'flaky-detect-alternating.counter');

test('alternating test (flaky by design)', () => {
  let n = 0;
  try { n = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 0; } catch { /* first run */ }
  fs.writeFileSync(marker, String(n + 1));
  assert.equal((n + 1) % 2, 1, `alternating fixture fails on even invocation #${n + 1}`);
});

test('always stable test (never flaky)', () => {
  assert.equal(1 + 1, 2);
});
