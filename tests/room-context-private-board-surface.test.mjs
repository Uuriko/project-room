import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createHostedRoomMcp } from '../server/mcp-room-profile.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

// Surface 2: board rows carry their own title, so /context availableClaims
// (and every other board consumer in orient) must honour the same
// private-definition boundary as state.workItems.
test('composed context withholds private titles from board-derived availableClaims for a claim-capable observer', async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  const identity = f.store.identities.create('Claim-capable observer');
  linkWithProof(f.store, f.keys.owner, 'commons', identity, { memberId: 'observer', displayName: 'Observer agent', permissions: ['accept_work', 'complete_work'] });
  const observer = identity.secret;
  send('work.proposed', { workItemId: 'private-brief', title: 'PRIVATE-TITLE-SENTINEL', definitionOfDone: 'PRIVATE-DONE-SENTINEL',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  f.store.dmConsents.request('commons', 'owner', 'producer', 'Synthetic private brief');
  f.store.dmConsents.decide('commons', 'producer', 'owner', 'approve');
  send('message.posted', { messageId: 'private-question', toMemberId: 'producer', workItemId: 'private-brief', requestKind: 'reply', body: 'q' });
  send('work.proposed', { workItemId: 'public-brief', title: 'PUBLIC-BOARD-TITLE', definitionOfDone: 'Public result',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  // Accepted work is mirrored onto the board, which is where the leak lived.
  for (const workItemId of ['private-brief', 'public-brief']) {
    f.store.command(f.keys.producer, 'commons', { id: crypto.randomUUID(), type: 'work.accepted', data: { workItemId, expectedRevision: 0 } });
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async path => {
    const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${observer}` } });
    assert.equal(response.status, 200); return response.json();
  };
  const mcp = createHostedRoomMcp(f.store);
  const mcpRead = async version => {
    const reply = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_room_context',
      arguments: { roomId: 'commons', ...(version ? { since_version: version } : {}) } } }, { authorization: `Bearer ${observer}` });
    assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
    return reply.result.structuredContent;
  };
  const full = await read('/api/rooms/commons/context');
  const mcpFull = await mcpRead();
  // Non-vacuous: the board surface is present and lists the private row.
  const privateRow = full.orient.availableClaims.find(item => item.id === 'private-brief');
  assert.ok(privateRow, 'private work must still be listed on the board surface (existence is not the secret)');
  assert.notEqual(privateRow.title, 'PRIVATE-TITLE-SENTINEL');
  assert.equal(full.orient.availableClaims.find(item => item.id === 'public-brief')?.title, 'PUBLIC-BOARD-TITLE');
  send('work.proposed', { workItemId: 'visible-next', title: 'Another public task', definitionOfDone: 'Public',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  const conditional = await read('/api/rooms/commons/context?since_version=' + full.context_version);
  const mcpConditional = await mcpRead(mcpFull.context_version);
  assert.notEqual(conditional.not_modified, true);
  assert.notEqual(mcpConditional.not_modified, true);
  for (const [surface, value] of [['HTTP full', full], ['HTTP conditional', conditional], ['MCP full', mcpFull], ['MCP conditional', mcpConditional]]) {
    const text = JSON.stringify(value);
    for (const sentinel of ['PRIVATE-TITLE-SENTINEL', 'PRIVATE-DONE-SENTINEL']) {
      assert.equal(text.includes(sentinel), false, `${surface} leaks ${sentinel} (substring scan)`);
    }
  }
});
