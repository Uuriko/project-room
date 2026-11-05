import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { makeTestSigner } from '../scripts/helpers/signed-evidence.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';

test('partial handoff resumes the original canonical contract after restart without inventing accepted work', t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-handoff-continuation-'));
  const file = join(directory, 'room.sqlite');
  let store = new RoomStore(file);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const command = (id, type, data) => store.command(token, 'commons', { id, type, data });
  command('policy', 'room.policy_set', { requireIndependentReview: false, requireOwnerDecision: false });
  const workItemId = 'continued-work';
  command('propose', 'work.proposed', { workItemId, title: 'Finish the original result',
    definitionOfDone: 'Both stages completed and exact result verified', accountableMemberId: 'owner', verifierMemberId: 'owner', mode: 'read' });
  const mutate = (id, type, data = {}) => command(id, type, { workItemId,
    expectedRevision: store.room('commons').state.workItems[workItemId].revision, ...data });
  mutate('accept', 'work.accepted');
  mutate('start', 'work.started');
  const handoff = { id: 'partial-handoff', type: 'work.handoff_recorded', data: { workItemId,
    expectedRevision: store.room('commons').state.workItems[workItemId].revision,
    doneSummary: 'Stage one saved', nextAction: 'Finish stage two of the same contract', limitReason: 'Host interrupted' } };
  store.command(token, 'commons', handoff);
  const before = store.room('commons').state.workItems[workItemId];
  const revision = before.revision;
  assert.equal(before.state, 'working');
  assert.equal(before.receipt, null, 'partial evidence is not completion');
  store.close(); store = new RoomStore(file);
  // A retry of the exact original command must not create more work or rewrite progress.
  store.command(token, 'commons', handoff);
  const resumed = store.room('commons').state.workItems[workItemId];
  assert.equal(resumed.revision, revision);
  assert.equal(resumed.handoff.doneSummary, 'Stage one saved');
  assert.equal(resumed.definitionOfDone, 'Both stages completed and exact result verified');
  assert.equal(resumed.accountableMemberId, 'owner');
  const evidenceVersion = 'sha256:' + 'b'.repeat(64);
  mutate('complete-original', 'work.completed', { summary: 'Both stages finished', nextAction: 'Review exact result',
    producerId: 'owner', evidenceVersion, signedEvidence: makeTestSigner(store)() });
  const receipt = store.room('commons').state.workItems[workItemId].receipt;
  mutate('verify-original', 'verification.recorded', { result: 'pass', completionEventId: receipt.eventId,
    evidenceVersion, summary: 'Both stages checked' });
  assert.equal(store.workClaims.get('commons', workItemId).state, 'done');
  assert.equal(store.room('commons').state.workItems[workItemId].receipt.eventId, receipt.eventId);
  assert.equal(store.room('commons').state.workItems[workItemId + '-next'], undefined);
  assert.equal(store.workClaims.get('commons', workItemId + '-next'), null,
    'a partial handoff must not manufacture a claimable second task without proposal, contract or acceptance');
});

test('an explicitly proposed follow-up preserves its own acceptance gate', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const workItemId = 'explicit-follow-up';
  store.command(token, 'commons', { id: 'explicit-proposal', type: 'work.proposed', data: {
    workItemId, title: 'An actual new slice', definitionOfDone: 'An explicitly agreed new result',
    accountableMemberId: 'owner', verifierMemberId: 'owner', mode: 'read' } });
  assert.equal(store.workClaims.get('commons', workItemId), null);
  store.command(token, 'commons', { id: 'explicit-acceptance', type: 'work.accepted', data: { workItemId, expectedRevision: 0 } });
  assert.equal(store.workClaims.get('commons', workItemId).workItemId, workItemId);
  assert.equal(store.workClaims.get('commons', workItemId).state, 'unclaimed');
});

test('old dangling cards retain history and offer recovery instead of new execution or a missing destination', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: { Origin: origin, authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  for (const claimed of [false, true]) {
    const id = 'historical-next-' + claimed;
    const initial = createWork({ id, title: 'Saved historical work', files: ['saved.txt'] }, { now: Date.now(), agentId: 'owner' });
    const row = { ...(claimed ? claimWork(initial, 'owner', { now: Date.now() }) : initial), workItemId: id };
    store.workClaims.set('commons', row);
    const before = store.workClaims.get('commons', id);
    for (const [route, body] of [['claim', {}], ['update', { state: 'in_progress' }], ['update', { state: 'delivered', note: 'Saved result' }]]) {
      const refused = await request(`/api/rooms/commons/work-claims/${id}/${route}`, body);
      assert.equal(refused.status, 409, JSON.stringify(refused));
      assert.equal(refused.body.linkedWork.status, 'unavailable');
      assert.equal(refused.body.next.some(next => next.path.includes('work-context')), false);
      assert.equal((await request(refused.body.next[0].path)).status, 200);
      assert.deepEqual(store.workClaims.get('commons', id), before, 'refusal does not rewrite saved history or scope');
    }
    const closed = await request(`/api/rooms/commons/work-claims/${id}/close`, { reason: 'Superseded by an explicitly authorized recovery plan' });
    assert.equal(closed.status, 200, JSON.stringify(closed));
    assert.equal(store.workClaims.get('commons', id).state, 'closed');
    assert.deepEqual(store.workClaims.get('commons', id).history.slice(0, before.history.length), before.history);
  }
});
