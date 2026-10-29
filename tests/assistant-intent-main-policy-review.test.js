import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/assistant`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.keys.owner}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' }),
  });
  assert.equal(response.status, 200, await response.text());
  const member = f.store.room('commons').state.members.owner;
  f.store.command(f.keys.owner, 'commons', {
    id: randomUUID(),
    type: 'member.access_changed',
    data: {
      memberId: 'owner',
      expectedMemberRevision: member.revision ?? 0,
      permissions: [...new Set([...member.permissions, 'steer'])],
      active: true,
    },
  });
  return f;
}

const post = (f, command) => f.store.command(f.keys.owner, 'commons', command);
const commandFor = (commandId, messageId) => ({
  id: commandId,
  type: 'message.posted',
  data: { messageId, body: '@Room, do this work.' },
});

test('an actual derived-ID collision refuses the second ask atomically and preserves the first run', async t => {
  const f = await setup(t);
  const longId = 'a'.repeat(128);
  const digestId = createHash('sha256').update(longId).digest('hex').slice(0, 60);
  post(f, commandFor('first-command', longId));
  const runId = `run-${digestId}`;
  const before = f.store.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? AND run_id=?').get('commons', runId).value;
  const head = f.store.headSequence('commons');
  const colliding = commandFor('colliding-command', digestId);

  assert.throws(() => post(f, colliding), error => error.status === 409 && error.code === 'assistant_run_exists');
  assert.equal(f.store.headSequence('commons'), head);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands WHERE room_id=? AND id=?').get('commons', colliding.id).n, 0);
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === digestId), false);
  assert.equal(f.store.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? AND run_id=?').get('commons', runId).value, before);
});

test('a derived-run insert failure rolls back, and the identical retry creates one message and one run', async t => {
  const f = await setup(t);
  const command = commandFor('retry-command', 'retry-source');
  const head = f.store.headSequence('commons');
  f.store.db.exec("CREATE TRIGGER injected_run_failure BEFORE INSERT ON room_assistant_runs BEGIN SELECT RAISE(ABORT,'injected run insert failure'); END");

  assert.throws(() => post(f, command), /injected run insert failure/);
  assert.equal(f.store.headSequence('commons'), head);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands WHERE room_id=? AND id=?').get('commons', command.id).n, 0);
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === 'retry-source'), false);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM room_assistant_runs WHERE room_id=? AND json_extract(value,'$.sourceMessageId')=?").get('commons', 'retry-source').n, 0);

  f.store.db.exec('DROP TRIGGER injected_run_failure');
  const accepted = post(f, command);
  assert.equal(accepted.duplicate, false);
  assert.equal(f.store.room('commons').state.messages.filter(message => message.id === 'retry-source').length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM room_assistant_runs WHERE room_id=? AND json_extract(value,'$.sourceMessageId')=?").get('commons', 'retry-source').n, 1);
  const afterAccepted = f.store.headSequence('commons');

  const replay = post(f, command);
  assert.equal(replay.duplicate, true);
  assert.equal(f.store.headSequence('commons'), afterAccepted);
  assert.equal(f.store.room('commons').state.messages.filter(message => message.id === 'retry-source').length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM room_assistant_runs WHERE room_id=? AND json_extract(value,'$.sourceMessageId')=?").get('commons', 'retry-source').n, 1);
});
