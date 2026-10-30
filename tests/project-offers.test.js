import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { unpublishPublic } from '../server/legal-store.mjs';
const input = (id = 'public-work') => ({ requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'], terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'project', title: 'Useful work', summary: 'Produce a reviewable result', acceptanceCriteria: ['One concrete accepted result'], reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'project-offer-store-')); const file = join(dir, 'room.sqlite');
  const store = new RoomStore(file); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file };
}
test('additive migration restores missing offer tables without changing prior room data or credits', t => {
  const { store, file } = fixture(t);
  const prior = store.db.prepare('SELECT projection,sequence FROM rooms WHERE id=?').get('commons');
  store.db.exec('DROP TABLE project_offers; DROP TABLE project_offer_requests;');
  const upgraded = new RoomStore(file);
  try {
    assert.deepEqual(upgraded.db.prepare('SELECT projection,sequence FROM rooms WHERE id=?').get('commons'), prior);
    assert.deepEqual(upgraded.projectOffers.list(), { offers: [], nextCursor: null });
    upgraded.projectOffers.create('commons', 'owner', input());
    assert.equal(upgraded.projectOffers.ownerList('commons', 'owner').offers.length, 1);
  } finally { upgraded.close(); }
});
test('publication revalidates current reviewer kind and archived rooms never expose published offers', t => {
  const { store } = fixture(t);
  store.projectOffers.create('commons', 'owner', input());
  const row = structuredClone(store.room('commons')); row.state.members.owner.kind = 'agent';
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(row.state), 'commons');
  assert.throws(() => store.projectOffers.transition('commons', 'owner', 'public-work', 'publish', { requestId: 'publish', expectedRevision: 1 }), error => error.code === 'invalid_project_offer');
  row.state.members.owner.kind = 'human';
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(row.state), 'commons');
  store.projectOffers.transition('commons', 'owner', 'public-work', 'publish', { requestId: 'publish', expectedRevision: 1 });
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'archive-offer-room', type: 'room.archived', data: {} });
  assert.deepEqual(store.projectOffers.list(), { offers: [], nextCursor: null });
  assert.throws(() => store.projectOffers.read('public-work'), error => error.code === 'offer_not_found');
});
test('operator unpublish removes a published offer from list, read and brief', t => {
  const { store } = fixture(t);
  store.projectOffers.create('commons', 'owner', input());
  store.projectOffers.transition('commons', 'owner', 'public-work', 'publish', { requestId: 'publish', expectedRevision: 1 });
  assert.equal(store.projectOffers.list().offers.length, 1);
  assert.equal(store.projectOffers.read('public-work').id, 'public-work');
  assert.ok(store.projectOffers.brief('public-work').includes('Useful work'));
  unpublishPublic(store.db, { kind: 'room', id: 'commons', byAccount: 'operator', now: store.now() });
  assert.deepEqual(store.projectOffers.list(), { offers: [], nextCursor: null });
  assert.throws(() => store.projectOffers.read('public-work'), error => error.code === 'offer_not_found');
  assert.throws(() => store.projectOffers.brief('public-work'), error => error.code === 'offer_not_found');
  // The owner's private view is not a public read: the offer still exists there.
  assert.equal(store.projectOffers.ownerList('commons', 'owner').offers.length, 1);
});
test('USD, USDC and internal milli-credit amounts do not authorize or imply payment', t => {
  const { store } = fixture(t);
  for (const [unit, decimals] of [['USD', 2], ['USDC', 6], ['credit', 3]]) {
    const draft = input(unit); draft.terms.reward = { kind: unit === 'credit' ? 'work_trade' : 'cash', unit, amountMinor: '100000000000000001', basis: 'pool' };
    const saved = store.projectOffers.create('commons', 'owner', draft);
    assert.equal(saved.reward.amountMinor, draft.terms.reward.amountMinor); assert.equal(saved.reward.decimals, decimals); assert.equal(saved.reward.basis, 'pool');
    assert.equal(saved.paymentStatus, unit === 'credit' ? 'ledger_only' : 'not_configured');
  }
});

test('agent-only review cannot contradict human-required Room or linked-work policy', t => {
  const { store } = fixture(t); const row = structuredClone(store.room('commons'));
  row.state.members.agent = { id: 'agent', kind: 'agent', active: true, displayName: 'Agent reviewer', permissions: ['verify'] };
  row.state.room.policy = { requireOwnerDecision: true, requireIndependentReview: false };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(row.state), 'commons');
  const request = input('agent-policy'); request.reviewerMemberIds = ['agent']; request.terms.approvalPolicy.mode = 'agent';
  assert.throws(() => store.projectOffers.create('commons', 'owner', request), error => error.code === 'invalid_project_offer');
  request.reviewerMemberIds = ['agent', 'owner']; request.terms.approvalPolicy.mode = 'human_with_agent_review';
  assert.equal(store.projectOffers.create('commons', 'owner', request).status, 'draft');
});

test('review permissions changing before the writer transaction cannot publish an outdated approval promise', t => {
  const { store } = fixture(t); store.projectOffers.create('commons', 'owner', input());
  const original = store.transaction.bind(store); let armed = true;
  store.transaction = fn => {
    if (armed) {
      armed = false; const state = structuredClone(store.room('commons').state); state.members.owner.permissions = [];
      store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
    }
    return original(fn);
  };
  assert.throws(() => store.projectOffers.transition('commons', 'owner', 'public-work', 'publish', { requestId: 'publish-current', expectedRevision: 1 }), error => error.code === 'invalid_project_offer');
  assert.deepEqual(store.projectOffers.list(), { offers: [], nextCursor: null });
});

test('a private draft without a return path cannot publish; an owner-authored submission URL is preserved publicly', t => {
  const { store } = fixture(t); const noPath = input('no-path'); delete noPath.terms.repositoryUrl;
  assert.equal(store.projectOffers.create('commons', 'owner', noPath).status, 'draft');
  assert.throws(() => store.projectOffers.transition('commons', 'owner', 'no-path', 'publish', { requestId: 'publish-no-path', expectedRevision: 1 }), error => error.code === 'invalid_project_offer');
  assert.deepEqual(store.projectOffers.list(), { offers: [], nextCursor: null });
  const useful = input('submission'); delete useful.terms.repositoryUrl; useful.terms.submissionUrl = 'https://github.com/Uuriko/project-room/issues';
  store.projectOffers.create('commons', 'owner', useful);
  store.projectOffers.transition('commons', 'owner', 'submission', 'publish', { requestId: 'publish-submission', expectedRevision: 1 });
  assert.equal(store.projectOffers.read('submission').submissionUrl, useful.terms.submissionUrl);
});


test('guest verify bits cannot publish an approval promise the guest scope cannot execute', t => {
  const { store } = fixture(t), key = store.issueAccessKey('commons', 'owner');
  const id = 'guest-agent-offer-review';
  store.command(key, 'commons', { id: 'add-guest-reviewer', type: 'member.added', data: {
    memberId: id, displayName: 'Guest reviewer', kind: 'agent', permissions: [], accountableHumanId: 'owner' } });
  store.command(key, 'commons', { id: 'grant-guest-review-bits', type: 'member.access_changed', data: {
    memberId: id, expectedMemberRevision: 0, permissions: ['verify'], active: true } });
  assert.deepEqual(store.room('commons').state.members[id].permissions, ['verify']);
  const draft = input('guest-review-promise');
  draft.reviewerMemberIds = [id]; draft.terms.approvalPolicy.mode = 'agent';
  assert.throws(() => store.projectOffers.create('commons', 'owner', draft), error => error.code === 'invalid_project_offer' && /guest/i.test(error.message));
  assert.deepEqual(store.projectOffers.ownerList('commons', 'owner').offers, []);
});

test('#3613 B1: offers carry citable criterion ids and a criteria hash pinned by the terms', t => {
  const { store } = fixture(t);
  const created = store.projectOffers.create('commons', 'owner', input());
  assert.deepEqual(created.acceptanceCriteriaWithIds, [{ criterionId: 'c1', text: 'One concrete accepted result' }]);
  assert.match(created.criteriaHash, /^[a-f0-9]{64}$/);
  // The pin is derived from the terms: a fresh public read recomputes the
  // identical pin, so what a verdict cites is exactly what the offer says.
  store.projectOffers.transition('commons', 'owner', 'public-work', 'publish', { requestId: 'publish', expectedRevision: 1 });
  const read = store.projectOffers.read('public-work');
  assert.equal(read.criteriaHash, created.criteriaHash);
  assert.deepEqual(read.acceptanceCriteriaWithIds, created.acceptanceCriteriaWithIds);
  // The public brief carries the ids and the hash, so work can cite them.
  const brief = store.projectOffers.brief('public-work');
  assert.ok(brief.includes('"criterionId": "c1"'));
  assert.ok(brief.includes(created.criteriaHash));
});

test('#3613 B1: rewording one criterion changes the hash; untouched criteria keep their ids', t => {
  const { store } = fixture(t);
  const terms = criteria => ({ repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'project', title: 'Useful work', summary: 'Produce a reviewable result', acceptanceCriteria: criteria, reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } });
  const a = store.projectOffers.create('commons', 'owner', { requestId: 'c-a', offerId: 'offer-a', reviewerMemberIds: ['owner'], terms: terms(['Alpha', 'Beta', 'Gamma']) });
  const b = store.projectOffers.create('commons', 'owner', { requestId: 'c-b', offerId: 'offer-b', reviewerMemberIds: ['owner'], terms: terms(['Alpha', 'Beta reworded', 'Gamma']) });
  assert.deepEqual(a.acceptanceCriteriaWithIds.map(entry => entry.criterionId), ['c1', 'c2', 'c3']);
  assert.deepEqual(b.acceptanceCriteriaWithIds.map(entry => entry.criterionId), ['c1', 'c2', 'c3']);
  assert.equal(a.acceptanceCriteriaWithIds[0].text, b.acceptanceCriteriaWithIds[0].text);
  assert.equal(a.acceptanceCriteriaWithIds[2].text, b.acceptanceCriteriaWithIds[2].text);
  assert.notEqual(a.criteriaHash, b.criteriaHash);
  // Deterministic derivation: identical criteria pin the identical hash.
  const c = store.projectOffers.create('commons', 'owner', { requestId: 'c-c', offerId: 'offer-c', reviewerMemberIds: ['owner'], terms: terms(['Alpha', 'Beta', 'Gamma']) });
  assert.equal(c.criteriaHash, a.criteriaHash);
});
