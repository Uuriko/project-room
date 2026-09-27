// Exercise the exported SDK over real HTTP: handler-only tests cannot catch
// fields silently dropped before reaching the server's validation and storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const token = store.issueAccessKey('commons', 'owner');
  store.command(token, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: [] } });
  const peerToken = store.issueAccessKey('commons', 'reviewer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { owner: new RoomAgentClient({ origin, roomId: 'commons', token }),
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
  const claim = await client.claimWorkItem('candidate', { files: ['src/shared.js', 'docs/claims.md'] });
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
  const { owner: client } = await fixture(t);
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
});


test('SDK review records the authenticated reviewer and satisfies distinct-member completion', async t => {
  const { owner, peer } = await fixture(t);
  await owner.workClaim('reviewed', { reviewPolicy: 'distinct_member' });
  await owner.updateWorkItem('reviewed', { state: 'in_progress' });
  const before = await owner.workClaimGet('reviewed');
  await assert.rejects(owner.workComplete('reviewed', { reviewedBy: 'reviewer' }),
    error => error.status === 403 && error.code === 'work_review_rejected');
  assert.deepEqual(await owner.workClaimGet('reviewed'), before);
  const reviewed = await peer.reviewWorkItem('reviewed', { note: 'Checked the result' });
  assert.equal(reviewed.attestations.length, 1);
  assert.equal(reviewed.attestations[0].memberId, 'reviewer');
  assert.equal(reviewed.attestations[0].note, 'Checked the result');
  await assert.rejects(peer.workComplete('reviewed', { reviewedBy: 'reviewer' }),
    error => error.status === 403 && error.code === 'work_not_owner');
  assert.deepEqual(await owner.workClaimGet('reviewed'), reviewed);
  const done = await owner.workComplete('reviewed', { reviewedBy: 'reviewer' });
  assert.equal(done.state, 'done');
  await assert.rejects(peer.reviewWorkItem('reviewed', { note: 'Too late' }), invalid);
  assert.deepEqual(await owner.workClaimGet('reviewed'), done);
});

test('SDK lease renewal needs the owner and a fresh public progress message', async t => {
  const { owner, peer } = await fixture(t);
  const claim = await owner.workClaim('renewed', { leaseHours: 1 });
  // The route deliberately requires progress strictly newer than lease start.
  await new Promise(resolve => setTimeout(resolve, 2));
  const progress = (await owner.say('Implemented the client boundary')).event.data.messageId;
  const foreign = (await peer.say('Someone else checked in')).event.data.messageId;
  const privateProgress = (await owner.say('Private update', { toMemberId: 'reviewer' })).event.data.messageId;
  const before = await owner.workClaimGet('renewed');
  await assert.rejects(peer.renewWorkItem('renewed', { progressMessageId: foreign }),
    error => error.status === 403 && error.code === 'work_not_owner');
  assert.deepEqual(await owner.workClaimGet('renewed'), before);
  for (const [progressMessageId, code] of [[foreign, 'claim_renewal_source_foreign'],
    [privateProgress, 'claim_renewal_source_required'], ['missing', 'claim_renewal_source_required']]) {
    await assert.rejects(owner.renewWorkItem('renewed', { progressMessageId }), error => error.code === code);
    assert.deepEqual(await owner.workClaimGet('renewed'), before);
  }
  const renewed = await owner.renewWorkItem('renewed', {
    progressMessageId: progress, leaseHours: 2, note: 'Continue the verified scope'
  });
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(claim.leaseExpiresAt));
  assert.equal(renewed.history.at(-1).note, 'Continue the verified scope');
  await assert.rejects(owner.renewWorkItem('renewed', { progressMessageId: progress }),
    error => error.status === 422 && error.code === 'claim_renewal_source_stale');
  assert.deepEqual(await owner.workClaimGet('renewed'), renewed);
});
