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
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token });
}

const invalid = error => error.status === 422 && error.code === 'invalid_claim_input';

test('SDK retains declared files, overlap warnings, and completion receipt metadata over HTTP', async t => {
  const client = await fixture(t);
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
  const client = await fixture(t);
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
  const client = await fixture(t);
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
