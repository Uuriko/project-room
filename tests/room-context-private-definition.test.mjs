import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createHostedRoomMcp } from '../server/mcp-room-profile.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

test('composed context preserves the same private definition boundary as default orientation', async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  const identity = f.store.identities.create('Unrelated observer');
  linkWithProof(f.store, f.keys.owner, 'commons', identity, { memberId: 'observer', displayName: 'Observer agent', permissions: [] });
  const observer = identity.secret;
  send('work.proposed', { workItemId: 'private-brief', title: 'PRIVATE-TITLE-SENTINEL',
    definitionOfDone: 'PRIVATE-DONE-SENTINEL', accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  f.store.dmConsents.request('commons', 'owner', 'producer', 'Synthetic private brief');
  f.store.dmConsents.decide('commons', 'producer', 'owner', 'approve');
  send('message.posted', { messageId: 'private-question', toMemberId: 'producer', workItemId: 'private-brief',
    requestKind: 'reply', body: 'PRIVATE-BODY-SENTINEL' });
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
  // An unrelated visible change forces a full conditional projection, so an
  // empty not_modified response cannot make the privacy assertion vacuous.
  send('work.proposed', { workItemId: 'visible-next', title: 'A public new task', definitionOfDone: 'Public result',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  const conditional = await read('/api/rooms/commons/context?since_version=' + context.context_version);
  const mcpConditional = await mcpRead(mcpContext.context_version);
  assert.notEqual(conditional.not_modified, true);
  assert.notEqual(mcpConditional.not_modified, true);
  const pathsOf = (value, sentinel, path = '') => {
    if (typeof value === 'string' && value.includes(sentinel)) return [path];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => pathsOf(child, sentinel, path + '/' + key));
  };
  const findings = [['HTTP full', context], ['HTTP conditional refresh', conditional], ['MCP full', mcpContext], ['MCP conditional refresh', mcpConditional]]
    .flatMap(([surface, value]) => ['PRIVATE-TITLE-SENTINEL', 'PRIVATE-DONE-SENTINEL', 'PRIVATE-BODY-SENTINEL']
      .map(sentinel => ({ surface, sentinel, paths: pathsOf(value, sentinel) })));
  t.diagnostic(JSON.stringify({ findings }));
  assert.deepEqual(findings.filter(finding => finding.paths.length), [], 'private work definition must not reappear through composed context');
});
