import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JOBS, jobRetryCadence, jobIsDue } from '../server/jobs.mjs';
import { runCronJobs, applyOutcomes, jobHealthView } from '../cloudflare/job-heartbeat.mjs';
import { writeDailyBackup, writeKvBackup, backupObjectKey } from '../cloudflare/room-backup.mjs';
const job = JOBS.find(row => row.name === 'room-backup');
const valid = JSON.stringify({ kind: 'watermark', events: 0 }) + '\n' + JSON.stringify({ kind: 'trailer', events: 0, eventsHash: createHash('sha256').digest('hex') }) + '\n';
const privateText = 'SENSITIVE_EXPORT_AND_CALLBACK_TOKEN';
test('failed backup retries no sooner than30minutes, then success returns to daily cadence', () => {
  const last = 1793400000000;
  for (const failures of [1, 2, 100]) {
    const cadence = jobRetryCadence(job, { consecutiveFailures: failures });
    assert.equal(cadence, 1800000);
    assert.equal(jobIsDue(job, null, last + cadence - 1, last, cadence), false);
    assert.equal(jobIsDue(job, null, last + cadence, last, cadence), true);
  }
  const cadence = jobRetryCadence(job, { consecutiveFailures: 0 });
  assert.equal(cadence, 86400000); assert.equal(jobIsDue(job, null, last + 1800000, last, cadence), false);
  assert.equal(job.slow, true);
});
for (const stage of ['binding', 'read', 'export', 'part_write', 'verification', 'manifest_write']) test(`backup ${stage} failure persists only fixed stage/code`, async () => {
  const kv = { get: async () => null, put: async key => {
    if (stage === 'part_write' && key.includes('.part-') || stage === 'manifest_write' && !key.includes('.part-')) throw Error(privateText);
  } };
  if (stage === 'read') kv.get = async () => { throw Error(privateText); };
  const env = { ROOM_BACKUPS_KV: stage === 'binding' ? {} : kv };
  const room = { exportRoomNdjson: async () => {
    if (stage === 'export') return new ReadableStream({ start(controller) { controller.error(Error(privateText)); } });
    return stage === 'verification' ? valid.replace('"events":0', '"events":1') : valid;
  } };
  const outcomes = await runCronJobs({ 'room-backup': () => job.run(null, { env, room }) });
  assert.equal(outcomes[0].ok, false);
  const stored = applyOutcomes({}, outcomes);
  assert.equal(stored['room-backup'].lastFailure.component, stage);
  assert.equal(stored['room-backup'].lastFailure.code, `backup_${stage}_failed`);
  assert.equal(JSON.stringify(stored).includes(privateText), false);
  const health = jobHealthView(stored, Date.now(), env);
  assert.equal(health.jobs.find(row => row.name === 'room-backup').lastErrorComponent, stage);
});
test('failed KV part write creates no manifest; retry produces one verified manifest', async () => {
  const values = new Map(); let failed = false, manifests = 0;
  const env = { ROOM_BACKUPS_KV: { get: async key => values.get(key), put: async (key, value) => {
    if (!failed) { failed = true; throw Error(privateText); }
    if (!key.includes('.part-')) manifests++;
    values.set(key, value);
  } } };
  const room = { exportRoomNdjson: async () => valid };
  await assert.rejects(writeDailyBackup(env, room)); assert.equal(manifests, 0);
  assert.ok((await writeDailyBackup(env, room)).wrote); assert.equal(manifests, 1);
  assert.equal((await writeDailyBackup(env, room)).skipped, 'exists'); assert.equal(manifests, 1);
});

test('partial orphan KV parts never count as success and later retry commits a verified manifest', async () => {
  const values = new Map(); let puts = 0, manifests = 0;
  const kv = { get: async key => values.get(key), put: async (key, value) => {
    puts++; if (puts === 2) throw Error(privateText);
    if (!key.includes('.part-')) manifests++;
    values.set(key, value);
  } };
  const key = backupObjectKey();
  await assert.rejects(writeKvBackup(kv, key, valid, { partBytes: 64 }));
  assert.equal(values.size, 1); assert.equal(values.has(key), false); assert.equal(manifests, 0);
  const retry = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, { exportRoomNdjson: async () => valid });
  assert.ok(retry.wrote); assert.equal(manifests, 1);
  const manifest = JSON.parse(values.get(key));
  const bytes = Buffer.concat(manifest.parts.map(part => Buffer.from(values.get(part.key))));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.equal((await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, { exportRoomNdjson: async () => { throw Error('must not export twice'); } })).skipped, 'exists');
});
