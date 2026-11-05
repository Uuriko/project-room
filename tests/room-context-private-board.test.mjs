import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createHostedRoomMcp } from '../server/mcp-room-profile.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

test('accepted private board work does not disclose its title through context discovery', async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  const identity = f.store.identities.create('Unrelated observer');
  linkWithProof(f.store, f.keys.owner, 'commons', identity, { memberId: 'observer', displayName: 'Observer agent', permissions: ['accept_work', 'complete_work'] });
  const observer = identity.secret;
  setTier(f.store.db, 'commons', 'observer', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  send('work.proposed', { workItemId: 'private-brief', title: 'PRIVATE-TITLE-SENTINEL',
    definitionOfDone: 'PRIVATE-DONE-SENTINEL', accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  f.store.dmConsents.request('commons', 'owner', 'producer', 'Synthetic private brief');
  f.store.dmConsents.decide('commons', 'producer', 'owner', 'approve');
  send('message.posted', { messageId: 'private-question', toMemberId: 'producer', workItemId: 'private-brief',
    requestKind: 'reply', body: 'PRIVATE-BODY-SENTINEL' });
  f.store.command(f.keys.producer, 'commons', { id: 'accept-private-board-work', type: 'work.accepted',
    data: { workItemId: 'private-brief', expectedRevision: 0 } });
  assert.equal(f.store.workClaims.get('commons', 'private-brief').state, 'unclaimed');
  f.store.workClaims.set('commons', { id: 'public-board-probe', title: 'Public pickup', state: 'unclaimed', owner: null, history: [] });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async path => {
    const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${observer}` } });
    assert.equal(response.status, 200); return response.json();
  };
  const orientation = await read('/api/rooms/commons?view=orientation');
  assert.equal(orientation.state.workItems['private-brief'].title, null);
  assert.equal(orientation.state.workItems['private-brief'].definitionOfDone, null);
  const context = await read('/api/rooms/commons/context');
  const mcp = createHostedRoomMcp(f.store);
  const mcpRead = async version => {
    const reply = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_room_context',
      arguments: { roomId: 'commons', ...(version ? { since_version: version } : {}) } } }, { authorization: `Bearer ${observer}` });
    assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
    return reply.result.structuredContent;
  };
  const mcpContext = await mcpRead();
  for (const packet of [context, mcpContext]) assert.equal(packet.orient.availableClaims.some(item => item.id === 'public-board-probe'), true, 'exercise actual board discovery, not a read-only empty section');
  // An unrelated visible change forces a full conditional projection, so an
  // empty not_modified response cannot make the privacy assertion vacuous.
  send('work.proposed', { workItemId: 'visible-next', title: 'A public new task', definitionOfDone: 'Public result',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  const conditional = await read('/api/rooms/commons/context?since_version=' + context.context_version);
  const mcpConditional = await mcpRead(mcpContext.context_version);
  assert.notEqual(conditional.not_modified, true);
  assert.notEqual(mcpConditional.not_modified, true);
  const claimed = await fetch(origin + '/api/rooms/commons/work-claims/private-brief/claim', { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${observer}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const canonical = f.store.room('commons').state.workItems['private-brief'];
  assert.notEqual(canonical.accountableMemberId, 'observer');
  assert.notEqual(canonical.claim?.holderId, 'observer');
  assert.equal(f.store.privateWorkParties('commons').get('private-brief').has('observer'), false);
  const claimedContext = await read('/api/rooms/commons/context');
  const mcpClaimedContext = await mcpRead();
  const pathsOf = (value, sentinel, path = '') => {
    if (typeof value === 'string' && value.includes(sentinel)) return [path];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => pathsOf(child, sentinel, path + '/' + key));
  };
  const findings = [['HTTP full', context], ['HTTP conditional refresh', conditional], ['MCP full', mcpContext], ['MCP conditional refresh', mcpConditional], ['HTTP claimed board', claimedContext], ['MCP claimed board', mcpClaimedContext]]
    .flatMap(([surface, value]) => ['PRIVATE-TITLE-SENTINEL', 'PRIVATE-DONE-SENTINEL', 'PRIVATE-BODY-SENTINEL']
      .map(sentinel => ({ surface, sentinel, paths: pathsOf(value, sentinel) })));
  t.diagnostic(JSON.stringify({ findings }));
  assert.deepEqual(findings.filter(finding => finding.paths.length), [], 'private work definition must not reappear through composed context');
});
