import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueSpendGrant } from '../server/spend-grants.mjs';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { openEvolution, canonical, digest } from '../client/evolution/store.mjs';
import { publishJobArtifacts, jobArtifactPlan, queueJobArtifacts, flushJobArtifacts } from '../client/evolution/artifacts.mjs';
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolution-artifacts-'));
  const room = new RoomStore(join(dir, 'room.sqlite')); room.initialize(initialRoom());
  const owner = room.issueAccessKey('commons', 'owner');
  for (const id of ['worker', 'other']) room.command(owner, 'commons', { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: id, displayName: id, kind: 'agent', permissions: [] } });
  issueSpendGrant(room.db, 'commons', 'worker', { grantedBy: 'owner', capCents: '100', perTxCapCents: '10', nowMs: Date.now() });
  const token = room.issueAccessKey('commons', 'worker'), other = room.issueAccessKey('commons', 'other');
  room.command(owner, 'commons', { id: crypto.randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: 'request-1', body: 'Run verification', toMemberId: 'worker', requestKind: 'reply' } });
  const server = createRoomServer({ store: room }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'worker', token };
  let store = openEvolution(join(dir, 'state'));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); room.close(); rmSync(dir, { recursive: true, force: true }); });
  const artifacts = [{ path: 'result.json', bytes: 2, sha256: digest('{}') }];
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('job', 'commons', 'op', '{}', 'a'.repeat(64), 'completed', 1, null, null,
    canonical({ artifacts, artifactDigest: digest(canonical(artifacts)) }));
  const output = join(store.directory, 'runs/job/1/artifacts'); mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'result.json'), '{}');
  const context = await new RoomAgentClient(connection).replyContext('request-1');
  room.command(token, 'commons', { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: 'result-1', body: 'Evidence', toMemberId: 'owner', replyToId: 'request-1', responseToRequestId: 'request-1',
    responseOutcome: 'answered', workItemId: null, ...context.current.answerBasis } });
  const args = { connection, jobId: 'job', requestMessageId: 'request-1', roomCreatedEventId: context.roomCreatedEventId, messageId: 'result-1' };
  return { dir, room, get store() { return store; }, restart() { store.close(); store = openEvolution(join(dir, 'state')); }, connection, args, output, other };
}
test('real server publication is readable by recipient, private from others, and retry-safe', async t => {
  const f = await fixture(t), result = await publishJobArtifacts(f.store, f.args);
  assert.equal(result.evidenceLocation, 'room'); assert.equal(result.files.length, 1);
  assert.deepEqual(await publishJobArtifacts(f.store, f.args), result);
  const path = f.connection.origin + result.files[0].path;
  assert.equal((await fetch(path, { headers: { Authorization: `Bearer ${f.other}` } })).status, 404);
  f.room.revokeRoomCredential('commons', 'worker', f.connection.token);
  await assert.rejects(publishJobArtifacts(f.store, f.args));
});
test('lost stage and commit responses reconcile original IDs without another upload or job', async t => {
  for (const lost of ['stage', 'commit']) {
    const f = await fixture(t); let dropped = false, stages = 0;
    const connection = { ...f.connection, fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      const stage = options.method === 'POST' && url.endsWith('/files'); if (stage) stages++;
      if (!dropped && response.ok && ((lost === 'stage' && stage) || (lost === 'commit' && url.endsWith('/commit')))) {
        dropped = true; await response.body.cancel(); throw new Error('lost_response');
      }
      return response;
    } };
    await assert.rejects(publishJobArtifacts(f.store, { ...f.args, connection }), /lost_response/);
    const result = await publishJobArtifacts(f.store, { ...f.args, connection });
    assert.equal(stages, 1); assert.equal(result.files.length, 1);
    assert.equal(f.store.db.prepare('SELECT attempt FROM jobs').get().attempt, 1);
  }
});
test('room recreation, changed local bytes and symlinks refuse publication', async t => {
  const f = await fixture(t);
  await assert.rejects(publishJobArtifacts(f.store, { ...f.args, roomCreatedEventId: 'other' }), /scope_changed/);
  writeFileSync(join(f.output, 'result.json'), '[]');
  assert.throws(() => jobArtifactPlan(f.store, 'job', { ...f.connection, ...f.args }), /artifact_changed/);
  unlinkSync(join(f.output, 'result.json')); writeFileSync(join(f.dir, 'outside'), '{}'); symlinkSync(join(f.dir, 'outside'), join(f.output, 'result.json'));
  assert.throws(() => jobArtifactPlan(f.store, 'job', { ...f.connection, ...f.args }), /path_invalid/);
});

test('durable outbox recovers after restart and reconciles a lost announcement', async t => {
  const f = await fixture(t); const key = queueJobArtifacts(f.store, f.args); f.restart();
  let dropped = false;
  const connection = { ...f.connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!dropped && response.ok && options.method === 'POST' && options.body?.includes(key)) {
      dropped = true; await response.body.cancel(); throw Error('lost_announcement');
    }
    return response;
  } };
  assert.equal((await flushJobArtifacts(f.store, { connection }))[0].state, 'waiting');
  f.restart();
  assert.equal((await flushJobArtifacts(f.store, { connection }))[0].state, 'published');
  assert.deepEqual(await flushJobArtifacts(f.store, { connection }), []);
  assert.equal(f.store.db.prepare('SELECT attempt FROM jobs').get().attempt, 1);
});
