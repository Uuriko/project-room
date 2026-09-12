import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';
import { createRoomServer } from '../server/http.mjs';

function setup(store) {
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'member', type: 'member.added', data: { memberId: 'agent', displayName: 'Agent', kind: 'agent', permissions: [] } });
  const agent = store.issueAccessKey('commons', 'agent');
  const q = store.command(owner, 'commons', { id: 'question', type: 'message.posted', data: { messageId: 'question', requestKind: 'reply', toMemberId: 'agent', body: 'A normal question' } });
  const claim = { id: 'claim', type: 'request_run.claimed', data: { requestMessageId: 'question', expectedRevision: 0, runId: 'run', contextEventId: q.event.id, instructionsRevision: 0, maxRuntimeMs: 10000, maxOutputBytes: 4096 } };
  return { owner, agent, claim };
}

test('durable request claims serialize, retry exactly, stop and replay without work', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const { owner, agent, claim } = setup(store);
  assert.throws(() => store.command(owner, 'commons', claim));
  const first = store.command(agent, 'commons', claim);
  assert.throws(() => store.command(agent, 'commons', { ...claim, id: 'competitor', data: { ...claim.data, runId: 'second' } }));
  const stop = { id: 'stop', type: 'request_run.stop_requested', data: { requestMessageId: 'question', expectedRevision: 1, runId: 'run' } };
  store.command(owner, 'commons', stop);
  assert.equal(store.command(agent, 'commons', claim).duplicate, true);
  assert.equal(store.command(agent, 'commons', claim).event.id, first.event.id);
  assert.equal(store.room('commons').state.requestRuns.question.status, 'stop_requested');
  const finish = { id: 'finish', type: 'request_run.finished', data: { requestMessageId: 'question', expectedRevision: 2, runId: 'run', status: 'cancelled' } };
  assert.throws(() => store.command(owner, 'commons', finish));
  store.command(agent, 'commons', finish);
  assert.deepEqual(store.room('commons').state.workItems, {});
  assert.equal(store.room('commons').state.replyRequests.question.status, 'open');
  assert.equal(auditRecovery(store).schemaVersion, 33);
  assert.throws(() => store.command(agent, 'commons', { ...claim, data: { ...claim.data, actorId: 'owner' } }), { code: 'invalid_command' });
  store.revoke(agent);
  assert.throws(() => store.command(agent, 'commons', claim), { status: 401 });
});

test('genuine v30 upgrade preserves data and rejects the pre-open old writer', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'request-v31-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = join(directory, 'old');
  createRuntimePackage({ repository: process.cwd(), commit: '6ebf919000da8741b17c6491327e9bf7bf791978', destination });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, 'server/store.mjs')));
  const filename = join(directory, 'room.sqlite'), old = new OldStore(filename);
  t.after(() => old.close());
  const f = setup(old), before = old.room('commons');
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 30);
  const cached = old.db.prepare('UPDATE rooms SET projection=projection WHERE id=?');
  const current = new RoomStore(filename); t.after(() => current.close());
  assert.deepEqual(current.room('commons'), before);
  assert.equal(current.db.prepare('PRAGMA user_version').get().user_version, 33);
  assert.throws(() => cached.run('commons'), /writer_v33|unsupported database writer/);
  current.command(f.agent, 'commons', f.claim);
  assert.equal(auditRecovery(current).schemaVersion, 33);
});

test('concurrent HTTP claim attempts yield only one new execution owner', async t => {
  const store = new RoomStore(':memory:'), f = setup(store), server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/rooms/commons/commands`;
  const post = command => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${f.agent}`, 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const commands = [f.claim, { ...f.claim, id: 'other', data: { ...f.claim.data, runId: 'other-run' } }];
  const results = await Promise.all(commands.map(post));
  assert.equal(results.filter(result => result.ok).length, 1);
  const winner = results.findIndex(result => result.ok), retry = await post(commands[winner]);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(store.room('commons').state.requestRuns.question.usedRunIds.length, 1);
});
