// Nested fixture: two parents each with a same-named subtest. parent A's
// subtest always passes; parent B's alternates pass/fail via a counter.
// A correct detector must report ONLY "parent B > 1 - same name subtest"
// as flaky — never parent A's stable subtest, and never merged counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const marker = process.env.FLAKY_DETECT_MARKER
  || path.join(os.tmpdir(), 'flaky-detect-nested.counter');

test('parent A', async (t) => {
  await t.test('same name subtest', () => {
    assert.equal(1 + 1, 2);
  });
});

test('parent B', async (t) => {
  await t.test('same name subtest', () => {
    let n = 0;
    try { n = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 0; } catch { /* first run */ }
    fs.writeFileSync(marker, String(n + 1));
    assert.equal((n + 1) % 2, 1, `alternating fixture fails on even invocation #${n + 1}`);
  });
});
