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
  const enable = (id, files = ['src/shared.js'], reward = { kind: 'unpaid' }, reference = 'main', roomId = 'commons') => {
    const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward, approvalPolicy: { mode: 'human' } } };
    store.projectOffers.create(roomId, 'owner', input);
    store.projectOffers.transition(roomId, 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable(roomId, 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: reference, files });
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

// Matching must choose through the exact same durable path-lock/lease mutation,
// not a second assignment ledger. Suggestions alone never reserve anything.
test('anonymous recommendations are grounded, bounded, and leave the registry/journal unchanged', t => {
  const f = fixture(t), [a] = f.identities;
  f.enable('a-docs', ['docs']); f.enable('b-typescript', ['src']); f.enable('c-overlap', ['src/file.js']);
  const before = f.store.db.prepare('SELECT count(*) AS n FROM public_work_requests').get().n;
  const result = f.service().match(null, { skills: ['typescript'], limit: 1 });
  assert.equal(result.recommendations[0].task.taskId, 'b-typescript');
  assert.deepEqual(result.recommendations[0].reasons, ['Matches preference: typescript']);
  assert.equal(result.claim, null); assert.equal(result.inspected, 3);
  assert.deepEqual(result.supportedRewards, ['volunteer']);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_requests').get().n, before);
  assert.ok(f.service().list().tasks.every(task => task.claim.state === 'unclaimed'));
  f.service().act('b-typescript', a.secret, 'claim', claim('hold-src'));
  assert.deepEqual(f.service().match(null, {}).recommendations.map(entry => entry.task.taskId), ['a-docs']);
  f.tick(3600001);
  assert.equal(f.service().match(null, {}).recommendations.length, 3);
  for (const reward of ['cash', 'work_trade']) assert.deepEqual(f.service().match(null, { reward }), {
    recommendations: [], claim: null, inspected: 0, hasMore: false, nextCursor: null, supportedRewards: ['volunteer'] });
  assert.throws(() => f.service().match(null, { autoClaim: true, requestId: 'no-auth' }), code('unauthenticated'));
  assert.throws(() => f.service().match('revoked', {}), code('unauthenticated'));
  assert.throws(() => f.service().match(null, { skills: ['bad\nvalue'] }), code('invalid_public_work'));
});

// The funnel's Step 3 dead-ends when no volunteer task is claimable: the
// response must hand the agent a self-serve next step instead of silence.
test('an exhausted volunteer board points at the self-serve fallback instead of dead-ending', t => {
  const f = fixture(t), [a] = f.identities;
  // Nothing enabled at all.
  const empty = f.service().match(null, { interests: ['docs'] });
  assert.deepEqual(empty.recommendations, []);
  assert.equal(empty.hasMore, false);
  assert.ok(Array.isArray(empty.next) && empty.next.length >= 1);
  const createRoom = empty.next.find(step => step.action === 'create-room');
  assert.equal(createRoom.method, 'POST');
  assert.equal(createRoom.path, '/api/agent-rooms');
  assert.match(createRoom.description, /starter/i);
  // Tasks exist but every one is held: same guidance, not silence.
  f.enable('held-task', ['docs/guide.md']);
  f.service().act('held-task', a.secret, 'claim', claim('hold-it'));
  const held = f.service().match(null, {});
  assert.deepEqual(held.recommendations, []);
  assert.ok(Array.isArray(held.next) && held.next.some(step => step.action === 'create-room'));
  // A board with something available stays quiet: no fallback noise.
  f.enable('open-task', ['docs/other.md']);
  const open = f.service().match(null, {});
  assert.equal(open.recommendations.length, 1);
  assert.equal(open.next, undefined);
});

test('explicit match claims exactly one task and retry retains chosen outcome through expiry/withdrawal/restart', t => {
  const f = fixture(t), [a, b] = f.identities;
  f.enable('a-docs', ['docs']); f.enable('b-typescript', ['src']); f.enable('c-overlap', ['src/file.js']);
  const input = { requestId: 'find-one', skills: ['typescript'], autoClaim: true };
  const result = f.service().match(a.secret, input);
  assert.equal(result.claim.action, 'claimed'); assert.equal(result.claim.task.taskId, 'b-typescript');
  assert.equal(f.service().list().tasks.filter(task => task.claim.state === 'claimed').length, 1);
  assert.deepEqual(f.service().match(a.secret, input), result);
  assert.throws(() => f.service().match(a.secret, { ...input, interests: ['docs'] }), code('request_id_reused'));
  // Different identity cannot take this task or its overlapping paths; it gets docs.
  const second = f.service().match(b.secret, { requestId: 'find-one', autoClaim: true });
  assert.equal(second.claim.task.taskId, 'a-docs');
  f.store.projectOffers.transition('commons', 'owner', 'b-typescript', 'withdraw', { requestId: 'withdraw-match', expectedRevision: 2 });
  f.tick(3600001); f.reopen();
  assert.deepEqual(f.service().match(a.secret, input), result);
  assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links').get().n, 0);
  f.store.db.prepare('UPDATE agent_identities SET secret_hash=? WHERE identity_id=?').run('revoked', a.identityId);
  assert.throws(() => f.service().match(a.secret, input), code('unauthenticated'));
});

test('matching exposes continuation when the first hundred tasks are held and rejects invalid cursors', t => {
  const f = fixture(t), [a, b] = f.identities;
  f.store.initialize(initialRoom('overflow'));
  for (let n = 0; n < 101; n++) {
    const id = 'page-' + String(n).padStart(3, '0');
    f.enable(id, ['files/' + id], { kind: 'unpaid' }, 'main', n === 100 ? 'overflow' : 'commons');
    if (n < 100) f.service().act(id, a.secret, 'claim', claim('hold-' + id));
  }
  const page = f.service().match(null, {});
  assert.deepEqual(page.recommendations, []); assert.equal(page.inspected, 100);
  assert.equal(page.hasMore, true); assert.equal(page.nextCursor, 'page-099');
  const next = f.service().match(b.secret, { requestId: 'next-page', after: page.nextCursor, autoClaim: true });
  assert.equal(next.claim.task.taskId, 'page-100'); assert.equal(next.inspected, 1);
  assert.equal(next.hasMore, false); assert.equal(next.nextCursor, null);
  assert.deepEqual(f.service().match(b.secret, { requestId: 'next-page', after: page.nextCursor, autoClaim: true }), next);
  assert.throws(() => f.service().match(null, { after: '../bad' }), code('invalid_public_work'));
  assert.throws(() => f.service().match(b.secret, { requestId: 'next-page', autoClaim: true }), code('request_id_reused'));
});

test('direct claim journal cannot impersonate a later matchmaking lease', t => {
  const f = fixture(t), [a] = f.identities; f.enable('alias-task');
  const matchRequest = 'future-match';
  const predicted = 'match_' + createHash('sha256').update(a.identityId + '\n' + matchRequest).digest('hex');
  f.service().act('alias-task', a.secret, 'claim', claim(predicted));
  f.service().act('alias-task', a.secret, 'release', owned('release-old', 1));
  const input = { requestId: matchRequest, autoClaim: true };
  const result = f.service().match(a.secret, input);
  assert.equal(result.claim.task.claim.generation, 2);
  assert.equal(f.service().read('alias-task').claim.state, 'claimed');
  assert.equal(f.service().read('alias-task').claim.generation, 2);
  assert.deepEqual(f.service().match(a.secret, input), result);
});

test('equally relevant recommendations prefer oldest work within the scanned page', t => {
  const f = fixture(t); f.enable('z-older', ['old']); f.tick(1000); f.enable('a-newer', ['new']);
  assert.deepEqual(f.service().match(null, {}).recommendations.map(entry => entry.task.taskId), ['z-older', 'a-newer']);
});

// G4 (usage-burn): a raced claim's 409 must name who holds the claim and
// when the lease expires — "Task already claimed" teaches nothing.
test('claim conflict names the holder identity and lease expiry', t => {
  const f = fixture(t), [a, b] = f.identities; f.enable('conflict-task');
  const claimed = f.service().act('conflict-task', a.secret, 'claim', claim('first-claim'));
  let err = null;
  try { f.service().act('conflict-task', b.secret, 'claim', claim('second-claim')); } catch (e) { err = e; }
  assert.ok(err, 'raced claim throws');
  assert.equal(err.code, 'public_work_claim_conflict');
  assert.equal(err.status, 409);
  assert.ok(err.message.includes(a.identityId), 'holder identity is named: ' + err.message);
  assert.ok(err.message.includes(claimed.task.claim.leaseExpiresAt), 'lease expiry is named: ' + err.message);
});

// G5 (usage-burn): finish with a stale generation must say whether the
// generation changed or the lease expired. The rejected artifact bytes are
// never stored, so the agent must re-submit them after re-claiming.
test('stale claim distinguishes changed generation from expired lease', t => {
  const f = fixture(t), [a] = f.identities;
  f.enable('changed-task');
  f.service().act('changed-task', a.secret, 'claim', claim('first'));
  f.service().act('changed-task', a.secret, 'release', owned('release', 1));
  f.service().act('changed-task', a.secret, 'claim', claim('second')); // generation 2
  let changed = null;
  try { f.service().act('changed-task', a.secret, 'finish', owned('old-finish', 1, { artifactText: 'Old result', checksReported: [] })); } catch (e) { changed = e; }
  assert.ok(changed, 'finish with old generation throws');
  assert.equal(changed.code, 'stale_public_claim');
  assert.equal(changed.status, 409);
  assert.ok(/changed/i.test(changed.message) && !/expired/i.test(changed.message),
    'says the generation changed (not ambiguously "expired or changed"): ' + changed.message);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_receipts').get().n, 0, 'rejected artifact bytes are not stored');
  f.enable('lapsed-task', ['lapsed.js']);
  f.service().act('lapsed-task', a.secret, 'claim', claim('hold', { leaseHours: 1 }));
  f.tick(3600001);
  let expired = null;
  try { f.service().act('lapsed-task', a.secret, 'finish', owned('late-finish', 1, { artifactText: 'Late result', checksReported: [] })); } catch (e) { expired = e; }
  assert.ok(expired, 'finish after lease lapse throws');
  assert.equal(expired.code, 'stale_public_claim');
  assert.equal(expired.status, 409);
  assert.ok(/expired|lapsed/i.test(expired.message) && !/changed/i.test(expired.message),
    'says the lease expired (not ambiguously "expired or changed"): ' + expired.message);
});
