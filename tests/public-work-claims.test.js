import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema, verifyPublicWorkClaimFence } from '../server/public-work-claim-fence.mjs';

// Real store/identity/offer/lease boundary; registration/HTTP/workerd keepers
// independently own transport and old-writer fencing. No registry doubles.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-domain-')), file = join(dir, 'room.sqlite');
  let clock = Date.now(), store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('First worker'), store.identities.create('Second worker')];
  const service = () => new PublicWorkClaims(store);
  const enable = (id, files = ['src/shared.js'], reward = { kind: 'unpaid' }, reference = 'main') => {
    const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward, approvalPolicy: { mode: 'human' } } };
    store.projectOffers.create('commons', 'owner', input);
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: reference, files });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, service, identities, enable,
    tick(ms) { clock += ms; }, reopen() { store.close(); store = new RoomStore(file, { now: () => clock }); } };
}
const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });
const code = expected => error => error.code === expected;

test('cold public index and strict shared repository path locks work without private membership', t => {
  const f = fixture(t), [a, b] = f.identities;
  assert.deepEqual(f.service().list(), { tasks: [], nextCursor: null });
  const first = f.enable('first:task', ['src']); f.enable('second.task', ['src/file.js']); f.enable('third-task', ['docs/readme.md']);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links').get().n, 0);
  assert.equal(f.service().list({ limit: 1 }).nextCursor, 'first:task');
  assert.equal(f.service().list({ after: 'first:task' }).tasks.length, 2);
  const args = claim('claim-first');
  const result = f.service().act('first:task', a.secret, 'claim', args);
  assert.equal(result.task.claim.identityId, a.identityId);
  assert.equal(result.task.claim.generation, 1);
  assert.deepEqual(f.service().act('first:task', a.secret, 'claim', args), result);
  assert.throws(() => f.service().act('first:task', b.secret, 'claim', claim('same-task')), code('public_work_claim_conflict'));
  assert.throws(() => f.service().act('second.task', b.secret, 'claim', claim('overlap')), code('public_work_path_conflict'));
  assert.equal(f.service().act('third-task', b.secret, 'claim', claim('nonoverlap')).task.claim.identityId, b.identityId);
  assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled, 0);
  assert.equal(Object.hasOwn(first, 'roomId'), false);
  assert.equal(JSON.stringify(first).includes('reviewerMemberIds'), false);
});

test('lease expiry/reclaim rejects prior generations and exact retries survive withdrawal and restart', t => {
  const f = fixture(t), [a, b] = f.identities; f.enable('lease-task');
  const first = f.service().act('lease-task', a.secret, 'claim', claim('a', { leaseHours: 1 }));
  assert.throws(() => f.service().act('lease-task', b.secret, 'renew', owned('wrong-owner', 1)), code('public_work_not_owner'));
  f.tick(3600001);
  assert.equal(f.service().read('lease-task').claim.state, 'unclaimed');
  const second = f.service().act('lease-task', b.secret, 'claim', claim('b'));
  assert.equal(second.task.claim.generation, 2);
  assert.throws(() => f.service().act('lease-task', a.secret, 'finish', owned('old-finish', 1, { artifactText: 'late', checksReported: [] })), code('stale_public_claim'));
  f.store.projectOffers.transition('commons', 'owner', 'lease-task', 'withdraw', { requestId: 'withdraw', expectedRevision: 2 });
  assert.throws(() => f.service().act('lease-task', b.secret, 'renew', owned('withdrawn-renew', 2)), code('offer_not_found'));
  assert.throws(() => f.service().act('lease-task', b.secret, 'finish', owned('withdrawn-finish', 2, { artifactText: 'late', checksReported: [] })), code('offer_not_found'));
  f.reopen();
  assert.deepEqual(f.service().act('lease-task', a.secret, 'claim', claim('a', { leaseHours: 1 })), first);
  assert.deepEqual(f.service().act('lease-task', b.secret, 'claim', claim('b')), second);
  assert.equal(f.service().act('lease-task', b.secret, 'release', owned('release', 2)).task.claim.state, 'unclaimed');
  assert.deepEqual(f.service().list(), { tasks: [], nextCursor: null });
});

test('submitted immutable receipt hashes exact UTF-8 bytes and reports checks without asserting acceptance', t => {
  const f = fixture(t), [a] = f.identities; f.enable('receipt-task');
  f.service().act('receipt-task', a.secret, 'claim', claim('claim'));
  const artifactText = 'Unicode 🐈\nquoted "text"\t', args = owned('finish', 1, { artifactText, checksReported: ['Caller says tests passed'] });
  const result = f.service().act('receipt-task', a.secret, 'finish', args);
  assert.equal(result.task.claim.state, 'submitted');
  assert.equal(result.receipt.state, 'submitted'); assert.equal(result.receipt.verification, 'hash_only');
  assert.equal(result.receipt.artifact.sha256, createHash('sha256').update(Buffer.from(artifactText)).digest('hex'));
  assert.equal(result.receipt.artifact.bytes, Buffer.byteLength(artifactText));
  f.reopen();
  assert.deepEqual(f.service().act('receipt-task', a.secret, 'finish', args), result);
  assert.deepEqual(f.service().receipt(result.receipt.receiptId), result.receipt);
  assert.deepEqual(f.service().artifact(result.receipt.receiptId), { artifactText, sha256: result.receipt.artifact.sha256, bytes: result.receipt.artifact.bytes });
  assert.throws(() => f.service().act('receipt-task', a.secret, 'finish', { ...args, artifactText: 'changed' }), code('request_id_reused'));
  assert.throws(() => f.service().act('receipt-task', a.secret, 'finish', { ...args, requestId: 'second-finish' }), code('public_work_already_submitted'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_receipts').get().n, 1);
  f.store.projectOffers.transition('commons', 'owner', 'receipt-task', 'withdraw', { requestId: 'withdraw', expectedRevision: 2 });
  assert.deepEqual(f.service().receipt(result.receipt.receiptId), result.receipt);
});

test('a reused identity cannot submit an earlier generation after release and reclaim', t => {
  const f = fixture(t), [a] = f.identities; f.enable('same-identity');
  f.service().act('same-identity', a.secret, 'claim', claim('first'));
  f.service().act('same-identity', a.secret, 'release', owned('release', 1));
  assert.equal(f.service().act('same-identity', a.secret, 'claim', claim('second')).task.claim.generation, 2);
  assert.throws(() => f.service().act('same-identity', a.secret, 'finish', owned('delayed-first', 1, { artifactText: 'Old result', checksReported: [] })), code('stale_public_claim'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_receipts').get().n, 0);
  assert.equal(f.service().act('same-identity', a.secret, 'finish', owned('current', 2, { artifactText: 'Current result', checksReported: [] })).receipt.generation, 2);
});

test('submission survives lease expiry and releases paths without reopening the completed task', t => {
  const f = fixture(t), [a, b] = f.identities; f.enable('submitted-task'); f.enable('followup-task');
  f.service().act('submitted-task', a.secret, 'claim', claim('claim'));
  const result = f.service().act('submitted-task', a.secret, 'finish', owned('finish', 1, { artifactText: 'Submitted result', checksReported: [] }));
  f.tick(3600001);
  f.reopen();
  assert.equal(f.service().read('submitted-task').claim.state, 'submitted');
  assert.equal(f.service().read('submitted-task').claim.submittedReceiptId, result.receipt.receiptId);
  assert.throws(() => f.service().act('submitted-task', b.secret, 'claim', claim('reclaim')), code('public_work_already_submitted'));
  for (const action of ['renew', 'release']) assert.throws(() => f.service().act('submitted-task', a.secret, action, owned(action, 1)), code('public_work_already_submitted'));
  assert.equal(f.service().act('followup-task', b.secret, 'claim', claim('next')).task.claim.state, 'claimed');
});

test('explicit opt-in and strict terms/lease/artifact limits refuse without claim or permit changes', t => {
  const f = fixture(t), [a] = f.identities;
  assert.throws(() => f.enable('cash-task', ['cash.js'], { kind: 'cash', unit: 'USD', amountMinor: '100' }), code('public_work_not_eligible'));
  f.enable('limits-task');
  for (const leaseHours of [null, 0, 25]) assert.throws(() => f.service().act('limits-task', a.secret, 'claim', claim('bad-lease', { leaseHours })), code('invalid_public_work'));
  assert.throws(() => f.service().act('limits-task', 'invalid', 'claim', claim('no-auth')), code('unauthenticated'));
  assert.throws(() => f.service().act('limits-task', a.secret, 'claim', claim('bad-version', { expectedTermsVersion: 2 })), code('stale_public_work'));
  f.service().act('limits-task', a.secret, 'claim', claim('good'));
  for (const artifactText of ['🦉'.repeat(16385), '\ud800']) assert.throws(() => f.service().act('limits-task', a.secret, 'finish', owned('bad-text', 1, { artifactText, checksReported: [] })), code('invalid_public_work'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_receipts').get().n, 0);
  assert.equal(verifyPublicWorkClaimFence(f.store.db), true);
  f.store.db.prepare('UPDATE agent_identities SET revoked_at=? WHERE identity_id=?').run(f.store.now(), a.identityId);
  assert.throws(() => f.service().act('limits-task', a.secret, 'claim', claim('good')), code('unauthenticated'));
});
