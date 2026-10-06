// Stable fixture: always passes, must NEVER be flagged as flaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('stable test one', () => {
  assert.equal(2 * 2, 4);
});

test('stable test two', () => {
  assert.ok(true);
});
