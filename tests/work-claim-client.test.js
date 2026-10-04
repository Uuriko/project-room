// Exercise the exported SDK over real HTTP: handler-only tests cannot catch
// fields silently dropped before reaching the server's validation and storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createWork, claimWork, updateWork } from '../server/work-claims.mjs';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
// SEC-2: claim reads carry content-trust markers; compare the claim itself.
const stripTrust = value => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'untrusted' || key === 'contentTrust' ? undefined : entry)));

async function fixture(t, { reviewerPermissions = [] } = {}) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const token = store.issueAccessKey('commons', 'owner');
  store.command(token, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: reviewerPermissions } });
  const peerToken = store.issueAccessKey('commons', 'reviewer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { store, owner: new RoomAgentClient({ origin, roomId: 'commons', token }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: peerToken }) };
}

const invalid = error => error.status === 422 && error.code === 'invalid_claim_input';

test('SDK retains declared files, overlap warnings, and completion receipt metadata over HTTP', async t => {
  const { owner: client } = await fixture(t);
  const created = await client.workClaimCreate({ id: 'holder', files: ['./src//shared.js'], tags: ['migration'] });
  assert.deepEqual(created.files, ['src/shared.js']);
  assert.deepEqual(created.tags, ['migration']);
  await client.claimWorkItem('holder');
  await client.workClaimCreate({ id: 'candidate' });
  await assert.rejects(client.claimWorkItem('candidate', { files: ['src/shared.js', 'docs/claims.md'] }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'file_lease_conflict');
    assert.deepEqual(error.holder, { claimId: 'holder', owner: 'owner' });
    assert.deepEqual(error.files, ['src/shared.js']);
    assert.equal(typeof error.leaseExpiresAt, 'string');
    return true;
  });
  const claim = await client.claimWorkItem('candidate', { files: ['src/shared.js', 'docs/claims.md'], advisory: true });
  assert.equal(claim.state, 'claimed');
  assert.deepEqual(claim.fileWarnings, [{ file: 'src/shared.js', heldBy: [{ id: 'holder', owner: 'owner' }] }]);
  await client.updateWorkItem('candidate', { state: 'in_progress' });
  const blobs = [`sha256:${'a'.repeat(64)}`];
  await client.updateWorkItem('candidate', { state: 'done', tags: ['sdk'], blobs });
  const saved = await client.workClaimGet('candidate');
  assert.deepEqual(saved.tags, ['sdk']);
  assert.deepEqual(saved.blobs, blobs);
  assert.deepEqual(saved.files, ['docs/claims.md', 'src/shared.js']);
});

test('SDK convenience claim and completion preserve creation metadata and explicit file replacement', async t => {
  const { owner: client } = await fixture(t);
  const made = await client.workClaim('convenience', {
    files: ['src/first.js'], tags: ['created'], reviewPolicy: 'distinct_member'
  });
  assert.deepEqual(made.files, ['src/first.js']);
  assert.deepEqual(made.tags, ['created']);
  assert.equal(made.reviewPolicy, 'distinct_member');
  await client.workRelease('convenience');
  const reclaimed = await client.workClaim('convenience', { files: [] });
  assert.deepEqual(reclaimed.files, []);
  assert.deepEqual(reclaimed.tags, ['created']);
  await client.workClaim('receipt', { files: ['docs/proof.md'] });
  await client.updateWorkItem('receipt', { state: 'in_progress' });
  const blobs = [`sha256:${'b'.repeat(64)}`];
  await client.workComplete('receipt', { deliveryMode: 'result', tags: ['verified'], blobs });
  const saved = await client.workClaimGet('receipt');
  assert.deepEqual(saved.tags, ['verified']);
  assert.deepEqual(saved.blobs, blobs);
});

test('SDK sends invalid declarations for server rejection instead of silently dropping them', async t => {
  const { owner: client, peer } = await fixture(t, { reviewerPermissions: ['verify'] });
  for (const [id, fields] of [['invalid-path', { files: ['../outside'] }], ['invalid-tag', { tags: ['not a tag'] }]]) {
    await assert.rejects(client.workClaimCreate({ id, ...fields }), invalid);
    await assert.rejects(client.workClaimGet(id), error => error.status === 404);
  }
  await client.workClaimCreate({ id: 'pending', files: ['src/original.js'] });
  await assert.rejects(client.claimWorkItem('pending', { files: ['/outside'] }), invalid);
  assert.equal((await client.workClaimGet('pending')).state, 'unclaimed');
  await client.claimWorkItem('pending');
  await client.updateWorkItem('pending', { state: 'in_progress' });
  for (const fields of [{ tags: ['not a tag'] }, { blobs: ['https://unverified.example'] }]) {
    await assert.rejects(client.workComplete('pending', fields), invalid);
    assert.equal((await client.workClaimGet('pending')).state, 'in_progress');
  }
  const beforeReview = await client.workClaimGet('pending');
  for (const fields of [
    { verdict: 'approved', summary: 'Invalid verdict' },
    { verdict: 'approve' },
    { verdict: 'approve', summary: '' },
    { verdict: 'approve', summary: 'Invalid URL', url: 'http://example.com/review' },
    { verdict: 'approve', summary: 'Mixed review forms', note: 'Legacy note' },
  ]) {
    await assert.rejects(peer.reviewWorkItem('pending', fields), invalid);
    assert.deepEqual(await client.workClaimGet('pending'), beforeReview);
  }
});


test('SDK preserves legacy notes and requires an explicit approval for reviewed completion', async t => {
  const { owner, peer } = await fixture(t, { reviewerPermissions: ['verify'] });
  await owner.workClaim('reviewed', { reviewPolicy: 'distinct_member' });
  await owner.updateWorkItem('reviewed', { state: 'in_progress' });
  const before = stripTrust(await owner.workClaimGet('reviewed'));
  await assert.rejects(owner.workComplete('reviewed', { reviewedBy: 'reviewer' }),
    error => error.status === 403 && error.code === 'work_review_rejected');
  assert.deepEqual(stripTrust(await owner.workClaimGet('reviewed')), before);
  const reviewed = await peer.reviewWorkItem('reviewed', { note: 'Checked the result' });
  assert.equal(reviewed.attestations.length, 1);
  assert.equal(reviewed.attestations[0].memberId, 'reviewer');
  assert.equal(reviewed.attestations[0].note, 'Checked the result');
  assert.deepEqual(reviewed.reviews, []);
  await assert.rejects(owner.workComplete('reviewed', { reviewedBy: 'reviewer' }),
    error => error.status === 403 && error.code === 'work_review_rejected');
  await assert.rejects(peer.workComplete('reviewed', { reviewedBy: 'reviewer' }),
    error => error.status === 403 && error.code === 'work_not_owner');
  assert.deepEqual(stripTrust(await owner.workClaimGet('reviewed')), reviewed);
  for (const verdict of ['comment', 'changes_requested']) {
    const negative = await peer.reviewWorkItem('reviewed', { verdict, summary: `Feedback: ${verdict}` });
    assert.equal(negative.reviews[0].verdict, verdict);
    assert.equal(negative.reviews[0].memberId, 'reviewer');
    await assert.rejects(owner.workComplete('reviewed', { reviewedBy: 'reviewer' }),
      error => error.status === 403 && error.code === 'work_review_rejected');
    assert.deepEqual(stripTrust(await owner.workClaimGet('reviewed')), negative);
  }
  const approval = { verdict: 'approve', summary: 'Explicitly approved the current result', url: 'https://example.com/review/result' };
  const approved = await peer.reviewWorkItem('reviewed', approval);
  assert.equal(approved.reviews[0].memberId, 'reviewer');
  for (const [field, value] of Object.entries(approval)) assert.equal(approved.reviews[0][field], value);
  assert.deepEqual(stripTrust((await owner.workClaimGet('reviewed')).reviews), approved.reviews);
  const done = await owner.workComplete('reviewed', { reviewedBy: 'reviewer' });
  assert.equal(done.state, 'done');
  assert.equal(done.reviewedBy, 'reviewer');
  await assert.rejects(peer.reviewWorkItem('reviewed', { note: 'Too late' }), invalid);
  assert.deepEqual(stripTrust(await owner.workClaimGet('reviewed')), done);
});

test('SDK lease renewal needs the owner and a fresh public progress message', async t => {
  const { owner, peer } = await fixture(t);
  const claim = await owner.workClaim('renewed', { leaseHours: 1 });
  // The route deliberately requires progress strictly newer than lease start.
  await new Promise(resolve => setTimeout(resolve, 2));
  const progress = (await owner.say('Implemented the client boundary')).event.data.messageId;
  const foreign = (await peer.say('Someone else checked in')).event.data.messageId;
  const privateProgress = (await owner.say('Private update', { toMemberId: 'reviewer' })).event.data.messageId;
  const before = stripTrust(await owner.workClaimGet('renewed'));
  await assert.rejects(peer.renewWorkItem('renewed', { progressMessageId: foreign }),
    error => error.status === 403 && error.code === 'work_not_owner');
  assert.deepEqual(stripTrust(await owner.workClaimGet('renewed')), before);
  for (const [progressMessageId, code] of [[foreign, 'claim_renewal_source_foreign'],
    [privateProgress, 'claim_renewal_source_required'], ['missing', 'claim_renewal_source_required']]) {
    await assert.rejects(owner.renewWorkItem('renewed', { progressMessageId }), error => error.code === code);
    assert.deepEqual(stripTrust(await owner.workClaimGet('renewed')), before);
  }
  const renewed = await owner.renewWorkItem('renewed', {
    progressMessageId: progress, leaseHours: 2, note: 'Continue the verified scope'
  });
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(claim.leaseExpiresAt));
  assert.equal(renewed.history.at(-1).note, 'Continue the verified scope');
  await assert.rejects(owner.renewWorkItem('renewed', { progressMessageId: progress }),
    error => error.status === 422 && error.code === 'claim_renewal_source_stale');
  assert.deepEqual(stripTrust(await owner.workClaimGet('renewed')), renewed);
});

// Transport owner: neither a pure transition nor a handler fixture catches the
// SDK dropping one of the mandatory compare-and-set fields before HTTP.
test('SDK links a later PR with both preconditions and preserves HTTP refusals', async t => {
  const { owner } = await fixture(t);
  const claimed = await owner.workClaim('later-sdk-pr', { files: ['src/sdk.js'], leaseHours: 6 });
  const args = { pullRequest: 'https://github.com/Uuriko/project-room/pull/17/',
    expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  const linked = await owner.linkWorkItemPullRequest(claimed.id, args);
  assert.equal(linked.pullRequests[0].url, args.pullRequest.slice(0, -1));
  assert.deepEqual(stripTrust(await owner.workClaimGet(claimed.id)), linked);
  await assert.rejects(owner.linkWorkItemPullRequest(claimed.id, args), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'work_claim_conflict');
    assert.ok(error.next.some(step => step.path === `/api/rooms/commons/work-claims/${claimed.id}`));
    assert.match(error.hint, /do not release or reacquire/i);
    return true;
  });
  const fresh = { ...args, expectedHistoryLength: linked.history.length };
  for (const fields of [{ expectedHistoryLength: String(linked.history.length) },
    { expectedClaimedAt: null }, { pullRequest: { url: args.pullRequest, outcome: 'merged' } }]) {
    await assert.rejects(owner.linkWorkItemPullRequest(claimed.id, { ...fresh, ...fields }), invalid);
  }
  assert.deepEqual(stripTrust(await owner.workClaimGet(claimed.id)), linked);
});

// Transport regression: handler coverage cannot see a state option dropped by
// the SDK, including when the SDK follows the server's opaque nextCursor.
test('SDK state filters retrieve older done claims through explicit and automatic pages', async t => {
  const { owner, store } = await fixture(t);
  const old = Date.now() - 30 * 86_400_000;
  const ids = Array.from({ length: 51 }, (_, index) => `older-${String(index).padStart(2, '0')}`);
  for (const id of ids) {
    let item = createWork({ id }, { agentId: 'owner', now: old });
    item = claimWork(item, 'owner', { now: old, leaseHours: 1 });
    item = updateWork(item, 'owner', { state: 'in_progress', now: old });
    item = updateWork(item, 'owner', { state: 'done', now: old });
    store.workClaims.set('commons', item);
  }
  await owner.workClaimCreate({ id: 'still-open' });
  const normal = await owner.workClaims();
  assert.deepEqual(normal.claims.map(item => item.id), ['still-open']);
  assert.equal(normal.olderDone, 51);
  assert.equal(normal.olderDoneQuery, 'state=done');
  const first = await owner.workClaims({ state: 'done', limit: 2 });
  assert.equal(first.state, 'done');
  assert.deepEqual(first.claims.map(item => item.id), ids.slice(0, 2));
  assert.equal(first.hasMore, true);
  const second = await owner.workClaims({ state: 'done', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.claims.map(item => item.id), ids.slice(2, 4));
  const all = await owner.workClaims({ state: 'done' });
  assert.deepEqual(all.claims.map(item => item.id), ids);
  assert.equal(all.hasMore, false);
  assert.equal(all.nextCursor, null);
  assert.ok(all.claims.every(item => item.state === 'done'));
  await assert.rejects(owner.workClaims({ state: 'bogus' }), invalid);
  await assert.rejects(owner.workClaims({ state: '' }), invalid);
  await assert.rejects(owner.workClaims({ queue: 'ready', state: 'done' }), invalid);
});

// The published OpenAPI example is client input, not an expected value derived
// from the implementation. Exercise it against a real capped stored history.
test('the documented capped-history PR basis succeeds through the SDK', async t => {
  const api = parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
  const schemas = api.paths['/api/rooms/{roomId}/work-claims/{claimId}/update'].post
    .requestBody.content['application/json'].schema.oneOf;
  const basis = schemas.find(schema => schema.required?.includes('appendPullRequest')).properties.expectedHistoryLength;
  assert.match(basis.description, /historyOmitted/);
  assert.equal(basis.example, 203);
  const { owner, store } = await fixture(t);
  await owner.workClaimCreate({ id: 'capped-sdk-pr', files: ['src/capped.js'] });
  let item = await owner.claimWorkItem('capped-sdk-pr', { leaseHours: 6 });
  const additions = 203 - item.history.length;
  for (let index = 0; index < additions; index++) item = updateWork(item, 'owner', { note: `Progress ${index}` });
  store.workClaims.set('commons', item);
  const read = await owner.workClaimGet(item.id);
  assert.equal(read.history.length, 200);
  assert.equal(read.historyOmitted, 3);
  const input = { pullRequest: 'https://github.com/Uuriko/project-room/pull/18', expectedClaimedAt: read.claimedAt };
  await assert.rejects(owner.linkWorkItemPullRequest(item.id, { ...input, expectedHistoryLength: 200 }),
    error => error.status === 409 && error.code === 'work_claim_conflict');
  assert.deepEqual(await owner.workClaimGet(item.id), read);
  const linked = await owner.linkWorkItemPullRequest(item.id, { ...input, expectedHistoryLength: basis.example });
  assert.equal(linked.pullRequests[0].url, input.pullRequest);
  assert.equal(linked.history.length, 200);
  assert.equal(linked.historyOmitted, 4);
  for (const key of ['owner', 'state', 'claimedAt', 'leaseStartAt', 'leaseExpiresAt', 'files']) {
    assert.deepEqual(linked[key], read[key]);
  }
});

// Bug hunt 2026-10-03 (area A, P2-1): the SDK follows up to 20 nextCursor
// continuations when the caller passes no limit/cursor. On a board larger
// than 21 pages it used to report hasMore:false with pages still unfetched —
// a silently truncated board. The walk must stay honest: hasMore:true with
// the outstanding cursor when the cap stops it early.
test('SDK auto-pagination signals truncation honestly past the 20-hop cap', async t => {
  const { owner, store } = await fixture(t);
  const now = Date.now();
  const total = 1051; // 21 pages + 1 at the default 50/page: the cap stops with one page left
  for (let index = 0; index < total; index++) {
    const id = `bulk-${String(index).padStart(4, '0')}`;
    store.workClaims.set('commons', createWork({ id, title: id }, { agentId: 'owner', now }));
  }
  const all = await owner.workClaims();
  assert.equal(all.claims.length, 1050);
  assert.equal(all.hasMore, true);
  assert.equal(typeof all.nextCursor, 'string');
  // The outstanding cursor resumes exactly where the walk stopped: one page.
  const rest = await owner.workClaims({ cursor: all.nextCursor });
  assert.equal(rest.claims.length, 1);
  assert.equal(rest.hasMore, false);
  const seen = new Set([...all.claims, ...rest.claims].map(item => item.id));
  assert.equal(seen.size, total);
});
