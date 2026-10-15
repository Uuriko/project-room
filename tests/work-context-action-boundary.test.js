import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { saveAgentConnection, readAgentConnection } from '../client/agent-connection.mjs';
import { readResumablePreparation } from '../client/work-context-cache.mjs';
import { submitWorkAction } from '../client/work-actions.mjs';

const workItemId = 'test-handoff';
async function fixture(t) {
  const f = createAcceptanceFixture();
  let store = f.store, server, port;
  const start = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(port ?? 0, '127.0.0.1', resolve));
    port = server.address().port;
  };
  const stop = async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  };
  await start();
  t.after(async () => { await stop(); rmSync(f.directory, { recursive: true, force: true }); });
  const directory = join(f.directory, 'connection');
  saveAgentConnection(directory, { version: 1, origin: `http://127.0.0.1:${port}`, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const connect = () => {
    const connection = readAgentConnection(directory);
    const client = new RoomAgentClient({ ...connection,
      fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Connection: 'close' } }) });
    return { client, read: () => readResumablePreparation(client, workItemId, { directory, connection }),
      act: (name, args) => submitWorkAction(client, connection, name, args) };
  };
  const owner = (type, data) => store.command(f.keys.owner, 'commons', { id: randomUUID(), type, data });
  const changeAccess = (permissions, active = true) => owner('member.access_changed', {
    memberId: 'producer', expectedMemberRevision: store.room('commons').state.members.producer.revision, permissions, active
  });
  const post = body => owner('message.posted', { messageId: randomUUID(), body, workItemId });
  const sequence = () => store.room('commons').sequence;
  const work = () => structuredClone(store.room('commons').state.workItems[workItemId]);
  return { connect, changeAccess, post, sequence, work,
    restart: async () => { await stop(); store = new RoomStore(join(f.directory, 'room.sqlite')); await start(); } };
}

async function prepareAcrossRestart(f) {
  const privateText = `Retained task discussion ${randomUUID()}`;
  f.post(privateText);
  const initial = await f.connect().read();
  assert.equal(initial.continuation.reused, false);
  await f.restart();
  f.post('New information after restart');
  const returning = f.connect(), resumed = await returning.read();
  assert.equal(resumed.continuation.reused, true);
  assert.equal(resumed.continuation.deltaItems, 1);
  assert.ok(resumed.discussion.items.some(item => item.message.body === privateText));
  return { returning, resumed, privateText };
}

test('resumed discussion cannot authorize an action after permission removal or escape after membership revocation', async t => {
  const f = await fixture(t);
  const { returning, resumed, privateText } = await prepareAcrossRestart(f);
  assert.ok(resumed.viewer.permissions.includes('accept_work'));
  const input = Object.freeze({ requestId: randomUUID(), workItemId, expectedRevision: resumed.work.revision });
  f.changeAccess([]);
  const sequence = f.sequence(), work = f.work();
  await assert.rejects(returning.act('room_accept_work', input), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'command_rejected');
    return true;
  });
  assert.equal(f.sequence(), sequence, 'rejected prepared action records no event');
  assert.deepEqual(f.work(), work, 'rejected action changes no work or result');
  const refreshed = await returning.read();
  assert.deepEqual(refreshed.viewer.permissions, []);
  assert.ok(refreshed.viewer.revision > resumed.viewer.revision);
  // Active membership still permits reading. Revoking membership must stop
  // all returned context, even though this process and disk retain its text.
  f.changeAccess([], false);
  const revokedSequence = f.sequence();
  for (const reader of [returning, f.connect()]) {
    await assert.rejects(reader.read(), error => {
      assert.ok([401, 403].includes(error.status), `membership refusal: ${error.code}`);
      assert.equal(JSON.stringify(error).includes(privateText), false);
      return true;
    });
  }
  assert.equal(f.sequence(), revokedSequence);
});

test('a resumed preparation does not rebase a stale action after another client advances the work', async t => {
  const f = await fixture(t);
  const { returning, resumed } = await prepareAcrossRestart(f);
  const staleInput = Object.freeze({ requestId: randomUUID(), workItemId, expectedRevision: resumed.work.revision });
  const otherClient = f.connect();
  const accepted = await otherClient.act('room_accept_work', { requestId: randomUUID(), workItemId, expectedRevision: resumed.work.revision });
  assert.equal(accepted.status, 'recorded');
  const sequence = f.sequence(), work = f.work();
  await assert.rejects(returning.act('room_start_work', staleInput), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'command_rejected');
    return true;
  });
  assert.equal(f.sequence(), sequence, 'stale action is not retried with a newer revision');
  assert.deepEqual(f.work(), work);
  assert.equal(staleInput.expectedRevision, resumed.work.revision);
  const current = await returning.read();
  assert.equal(current.work.revision, accepted.appliedRevision);
  const started = await returning.act('room_start_work', {
    requestId: randomUUID(), workItemId, expectedRevision: current.work.revision
  });
  assert.equal(started.status, 'recorded', 'only a fresh deliberate action advances the task');
  assert.equal(f.work().revision, current.work.revision + 1);
  assert.ok(f.sequence() >= started.sequence);
  assert.ok(started.sequence > sequence);
});
