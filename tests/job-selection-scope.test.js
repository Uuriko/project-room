import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkerJobs } from '../cloudflare/job-heartbeat.mjs';

test('selecting retention does not scan unrelated job eligibility', () => {
  const queries = [];
  const store = { db: { prepare(sql) { queries.push(sql); throw new Error('unrelated scan'); } } };
  const selected = selectWorkerJobs({}, store, { onlyJob: 'retention', includeSlow: true });
  assert.deepEqual(selected.map(job => job.name), ['retention']);
  assert.deepEqual(queries, []);
  assert.deepEqual(selectWorkerJobs({}, store, { onlyJob: 'retention', includeSlow: false }), []);
  assert.deepEqual(queries, []);
});

test('targeted selection still enforces configuration and runtime eligibility', () => {
  assert.deepEqual(selectWorkerJobs({ ROOM_GMAIL_ENABLED: '0' }, null, { onlyJob: 'gmail-sync' }), []);
  assert.deepEqual(selectWorkerJobs({ ROOM_GMAIL_ENABLED: '1' }, null, { onlyJob: 'gmail-sync' }).map(job => job.name), ['gmail-sync']);
  assert.deepEqual(selectWorkerJobs({}, null, { onlyJob: 'growth-watch' }), []);
});
