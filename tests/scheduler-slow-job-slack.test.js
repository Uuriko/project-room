import test from 'node:test';
import assert from 'node:assert/strict';
import { jobIsDue, HOUR_MS } from '../server/jobs.mjs';

const slowHourly = { name: 'integrity', cadenceMs: HOUR_MS, slow: true, runtimes: ['worker'] };
const fastHourly = { name: 'fast', cadenceMs: HOUR_MS, runtimes: ['worker'] };

test('slow job is due inside the 60s slack window (cron fired before the anchor)', () => {
  const now = 1_800_000_000_000;
  const last = now - HOUR_MS + 30_000; // anchor is 30s in the future
  assert.equal(jobIsDue(slowHourly, null, now, last), true);
});

test('fast job gets no slack: not due while the anchor is still in the future', () => {
  const now = 1_800_000_000_000;
  const last = now - HOUR_MS + 30_000;
  assert.equal(jobIsDue(fastHourly, null, now, last), false);
});

test('slow job is not due when the anchor is still more than 60s away', () => {
  const now = 1_800_000_000_000;
  const last = now - HOUR_MS + 90_000;
  assert.equal(jobIsDue(slowHourly, null, now, last), false);
});

test('slow job past its cadence stays due (guard)', () => {
  const now = 1_800_000_000_000;
  const last = now - HOUR_MS - 5 * 60_000;
  assert.equal(jobIsDue(slowHourly, null, now, last), true);
});
