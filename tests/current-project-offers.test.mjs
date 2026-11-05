import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const input = id => ({ requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
  terms: { kind: 'task', title: 'Synthetic work', summary: 'A local test', acceptanceCriteria: ['One result'],
    reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' }, submissionUrl: 'https://example.invalid/result' } });

test('normalized owner offer lifecycle uses bounded reads and rechecks current review authority', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), { representation: 'normalized-current-v1' });
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'add-peer', type: 'member.added', data: { memberId: 'peer', displayName: 'Peer', kind: 'human', permissions: [] } });
  const peer = store.issueAccessKey('commons', 'peer');
  // A full room read must not silently re-enter this path.
  store.room = () => { throw new Error('unexpected full room read'); };
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, base = '/api/rooms/commons/project-offers';
  const call = (path, data, key = owner) => fetch(origin + path, { method: data ? 'POST' : 'GET',
    headers: { Origin: origin, Authorization: `Bearer ${key}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await call(base)).status, 200);
  assert.equal((await call(base, input('not-owner'), peer)).status, 403);
  const missing = input('missing-reviewer'); missing.reviewerMemberIds = ['missing'];
  assert.equal((await call(base, missing)).status, 422);
  const inherited = input('inherited-reviewer'); inherited.reviewerMemberIds = ['constructor'];
  assert.equal((await call(base, inherited)).status, 422);
  const absentWork = input('missing-work'); absentWork.workItemId = 'toString';
  assert.equal((await call(base, absentWork)).status, 422);
  const draft = input('offer');
  assert.equal((await call(base, draft)).status, 201);
  assert.equal((await call(base, draft)).status, 201);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_offers').get().n, 1);
  assert.equal((await call(`${base}/offer/publish`, { requestId: 'publish', expectedRevision: 1 })).status, 200);
  assert.equal((await call(`${base}/offer/withdraw`, { requestId: 'withdraw', expectedRevision: 2 })).status, 200);
  assert.equal((await call(base)).status, 200);
  const another = input('recheck'); assert.equal((await call(base, another)).status, 201);
  store.command(owner, 'commons', { id: 'remove-decision', type: 'member.access_changed', data: { memberId: 'owner', expectedMemberRevision: 0, permissions: ['manage_members'], active: true } });
  assert.equal((await call(`${base}/recheck/publish`, { requestId: 'publish-recheck', expectedRevision: 1 })).status, 422);
  assert.equal(store.db.prepare("SELECT status FROM project_offers WHERE offer_id='recheck'").get().status, 'draft');
});

test('normalized linked work requires its designated independent verifier', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  store.initialize(initialRoom(), { representation: 'normalized-current-v1' });
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'add-reviewer', type: 'member.added', data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'agent', permissions: ['verify'], accountableHumanId: 'owner' } });
  store.command(owner, 'commons', { id: 'work', type: 'work.proposed', data: { workItemId: 'task', title: 'Task', definitionOfDone: 'Result', accountableMemberId: 'owner', verifierMemberId: 'reviewer', independentVerificationRequired: true } });
  store.room = () => { throw new Error('unexpected full room read'); };
  const linked = input('linked'); linked.workItemId = 'task';
  assert.throws(() => store.projectOffers.create('commons', 'owner', linked), e => e.code === 'invalid_project_offer');
  linked.reviewerMemberIds = ['owner', 'reviewer']; linked.terms.approvalPolicy.mode = 'human_with_agent_review';
  assert.equal(store.projectOffers.create('commons', 'owner', linked).status, 'draft');
  assert.equal(store.projectOffers.transition('commons', 'owner', 'linked', 'publish', { requestId: 'publish-linked', expectedRevision: 1 }).status, 'published');
});
