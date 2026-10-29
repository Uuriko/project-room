// The server derives a shared request from a plain addressed post, so the
// first ask in a freshly configured room never depends on the client's
// assistant projection being fresh (fo-qa-c10-202610280645).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (actor, input, expected = 200) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.keys[actor]}`, ...(input ? {'content-type': 'application/json'} : {}) }, ...(input ? {body: JSON.stringify({ requestId: randomUUID(), ...input })} : {}) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const message = (actor, id, body = 'Shared input', extra = {}) => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body, ...extra } });
  return { f, api, message, origin };
}

const grantSteer = (f, memberId) => {
  const member = f.store.room('commons').state.members[memberId];
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'member.access_changed', data: { memberId, expectedMemberRevision: member.revision ?? 0, permissions: [...new Set([...member.permissions, 'steer'])], active: true } });
};

test('a plain addressed post from a human with steer starts the run server-side', async t => {
  const { f, api, message } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  grantSteer(f, 'owner');
  message('owner', 'owner-ask-1', '@Room, please write the release notes.');
  const { runs } = await api('owner');
  const run = runs.find(candidate => candidate.id === 'run-owner-ask-1');
  assert.ok(run, 'a shared request exists for the plain ask');
  assert.equal(run.status, 'queued');
  assert.equal(run.initiatorId, 'owner');
  assert.equal(run.coordinatorMemberId, 'producer');
  assert.deepEqual(run.inputs.map(entry => entry.sourceMessageId), ['owner-ask-1']);
});

test('the derived run makes a lagging submit a receipt, not a conflict', async t => {
  const { f, api, message } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  grantSteer(f, 'owner');
  message('owner', 'owner-ask-2', '@Room, please write the release notes.');
  const direct = await api('owner', { action: 'invoke', runId: 'run-owner-ask-2', sourceMessageId: 'owner-ask-2' });
  assert.equal(direct.result.status, 'queued');
  // The submit path would rebuild the identical run: the server must hand
  // back the same request instead of failing the send.
  const again = await api('owner', { action: 'invoke', runId: 'run-owner-ask-2', sourceMessageId: 'owner-ask-2' });
  assert.equal(again.result.id, 'run-owner-ask-2');
  const { runs } = await api('owner');
  assert.equal(runs.filter(run => run.sourceMessageId === 'owner-ask-2').length, 1);
});

test('the atomic submit still lands when the server derived the run first', async t => {
  const { f, api } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  grantSteer(f, 'owner');
  // The submit posts the message first (which derives the run server-side),
  // then applies its own invoke: the derived run must read as a receipt, not
  // a conflict, and the submit must not queue a second request.
  const input = { action: 'submit', command: { id: randomUUID(), type: 'message.posted', data: { messageId: 'owner-ask-3', body: '@Room, please write the release notes.' } }, intent: { action: 'invoke' }, fileIds: [] };
  const submitted = await api('owner', input);
  assert.equal(submitted.result.status, 'queued');
  const { runs } = await api('owner');
  assert.equal(runs.filter(run => run.sourceMessageId === 'owner-ask-3').length, 1);
  assert.equal(runs.find(run => run.sourceMessageId === 'owner-ask-3').initiatorId, 'owner');
});

test('agents, steerless humans and unaddressed posts never start a run', async t => {
  const { api, message } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  message('producer', 'prod-ask', '@Room, I will handle this myself.');
  message('guest', 'guest-ask', '@Room, what is the status?');
  message('owner', 'owner-plain', 'Please write the release notes.');
  message('owner', 'owner-dm', '@Room, quietly.', { toMemberId: 'producer' });
  const { runs } = await api('owner');
  assert.deepEqual(runs.filter(run => ['run-prod-ask', 'run-guest-ask', 'run-owner-plain', 'run-owner-dm'].includes(run.id)), []);
});

test('a room without a configured assistant derives nothing', async t => {
  const { api, message } = await setup(t);
  message('owner', 'owner-ask-4', '@Room, please write the release notes.');
  const { runs } = await api('owner');
  assert.deepEqual(runs, []);
});

test('a steerless ask still lands the message, then steering derives it on the next post', async t => {
  const { f, api, message } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  message('guest', 'guest-ask-2', '@Room, what is the status?');
  grantSteer(f, 'guest');
  message('guest', 'guest-ask-3', '@Room, what is the status now?');
  const { runs } = await api('owner');
  assert.ok(runs.some(run => run.id === 'run-guest-ask-3'));
  assert.ok(!runs.some(run => run.id === 'run-guest-ask-2'));
});

test('a 128-character source messageId still yields a claimable run', async t => {
  const { f, api, message } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  grantSteer(f, 'owner');
  const longId = 'm' + 'x'.repeat(127);
  assert.equal(longId.length, 128);
  message('owner', longId, '@Room, please write the release notes.');
  const { runs } = await api('owner');
  const run = runs.find(candidate => candidate.sourceMessageId === longId);
  assert.ok(run, 'the derived run exists');
  assert.ok(run.id.length <= 128, 'the run id fits the room id cap');
  assert.notEqual(run.id, `run-${longId}`);
  // The producer can act on the derived run: its id passes every later
  // assistant action's validId check instead of dead-ending at 132 characters.
  const claimed = await api('producer', { action: 'claim', runId: run.id, attemptId: 'producer-attempt-boundary', expectedRevision: 0 });
  assert.equal(claimed.result.id, run.id);
  assert.equal(claimed.result.attemptId, 'producer-attempt-boundary');
  // Replay stays exactly-once: the same source message maps to one run.
  const again = await api('owner');
  assert.equal(again.runs.filter(candidate => candidate.sourceMessageId === longId).length, 1);
});

test('source message ids that fit keep the run-${id} form', async t => {
  const { f, api, message } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  grantSteer(f, 'owner');
  const fitsId = 'm' + 'x'.repeat(123);
  assert.equal(`run-${fitsId}`.length, 128);
  message('owner', fitsId, '@Room, please write the release notes.');
  const { runs } = await api('owner');
  assert.ok(runs.some(run => run.id === `run-${fitsId}` && run.sourceMessageId === fitsId));
});

test('submit and derivation map one source message to one run id at the boundary', async t => {
  const { f, api } = await setup(t);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  grantSteer(f, 'owner');
  const longId = 's' + 'x'.repeat(127);
  // The atomic submit derives the run server-side while posting, then applies
  // its own invoke with the same bounded id: no 132-character id is built.
  const input = { action: 'submit', command: { id: randomUUID(), type: 'message.posted', data: { messageId: longId, body: '@Room, please write the release notes.' } }, intent: { action: 'invoke' }, fileIds: [] };
  const submitted = await api('owner', input);
  assert.equal(submitted.result.status, 'queued');
  assert.ok(submitted.result.id.length <= 128);
  const { runs } = await api('owner');
  assert.equal(runs.filter(run => run.sourceMessageId === longId).length, 1);
});
