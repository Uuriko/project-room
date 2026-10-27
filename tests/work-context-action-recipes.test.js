import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { buildWorkCommand, conforms, workTools, workActionContractRevision, WORK_ACTION_CONTRACT_REVISION } from '../client/work-actions.mjs';
import { searchActions } from '../server/mcp-action-search.mjs';
import { hostedStdioToolDefinitions } from '../server/mcp-full-profile.mjs';

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async (actor = 'producer', path = '/api/rooms/commons/work-context?workItemId=recipe-work') => {
    const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${f.keys[actor]}` } });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const post = (command, actor = 'producer') => fetch(origin + '/api/rooms/commons/commands', { method: 'POST',
    headers: { Authorization: `Bearer ${f.keys[actor]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type, data });
  send('owner', 'work.proposed', { workItemId: 'recipe-work', title: 'Test recipes', definitionOfDone: 'Verified', accountableMemberId: 'producer', mode: 'write' });
  send('producer', 'work.accepted', { workItemId: 'recipe-work', expectedRevision: 0 });
  return { ...f, origin, read, post, send };
}

function fill(recipe, inputs) {
  assert.equal(conforms(inputs, recipe.inputSchema), true, 'caller input follows the provided schema');
  const { requestId, ...data } = inputs;
  const command = { ...recipe.http.command, id: requestId, data: { ...recipe.http.command.data, ...data } };
  assert.deepEqual(command, buildWorkCommand(recipe.tool, { ...recipe.arguments, ...inputs }), 'HTTP and MCP use the existing command builder semantics');
  return command;
}

test('selected claim recipes execute take, renew, release and handoff over HTTP with exact revisions', async t => {
  const f = await fixture(t);
  let context = await f.read();
  assert.deepEqual((await f.read('guest')).actionRecipes, []);
  assert.deepEqual((await f.read('reviewer')).actionRecipes, []);
  const take = context.actionRecipes.find(action => action.arguments.action === 'take');
  assert.ok(take);
  assert.equal(take.arguments.expectedRevision, 1);
  assert.deepEqual(take.requiredInput, ['requestId', 'repository', 'ref', 'paths', 'expiresAt']);
  assert.equal(take.executionGranted, false);
  assert.deepEqual(take.capability, { supported: true, authorization: 'checked_on_submit', runtimeConfigured: 'unknown', runtimeVerified: 'unknown' });
  const input = { requestId: randomUUID(), repository: 'test/repo', ref: 'main', paths: ['recipes/**'], expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const command = fill(take, input);
  let response = await f.post(command);
  assert.equal(response.status, 201, await response.clone().text());
  response = await f.post(command);
  assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
  context = await f.read('producer', take.http.verify.path);
  assert.equal(context.work.claim.holderId, 'producer');
  assert.equal(context.work.revision, 2);
  assert.equal(context.actionRecipes.some(action => action.arguments.action === 'take'), false);
  const renew = context.actionRecipes.find(action => action.arguments.action === 'renew');
  response = await f.post(fill(renew, { requestId: randomUUID(), expiresAt: new Date(Date.now() + 7200000).toISOString() }));
  assert.equal(response.status, 201, await response.clone().text());
  context = await f.read('producer', renew.http.verify.path);
  const release = context.actionRecipes.find(action => action.arguments.action === 'release');
  assert.equal(release.arguments.expectedRevision, 3);
  response = await f.post(fill(release, { requestId: randomUUID() }));
  assert.equal(response.status, 201, await response.clone().text());
  context = await f.read('producer', release.http.verify.path);
  assert.equal(context.work.claim.status, 'released');
  const handoff = context.actionRecipes.find(action => action.tool === 'room_handoff');
  assert.deepEqual(handoff.requiredInput, ['requestId', 'doneSummary', 'nextAction', 'limitReason']);
  response = await f.post(fill(handoff, { requestId: randomUUID(), doneSummary: 'Scope verified', nextAction: 'Continue implementation', limitReason: 'Context exhausted' }));
  assert.equal(response.status, 201, await response.clone().text());
  context = await f.read('producer', handoff.http.verify.path);
  assert.equal(context.work.handoff.open, true);
  assert.equal(context.work.state, 'accepted', 'handoff is not completion or reassignment');
  assert.equal(context.work.accountableMemberId, 'producer');
});

test('recipes are observations, not grants: stale revision and revoked access fail without a new effect', async t => {
  const f = await fixture(t), context = await f.read();
  const handoff = context.actionRecipes.find(action => action.tool === 'room_handoff');
  const command = fill(handoff, { requestId: randomUUID(), doneSummary: 'Partial', nextAction: 'Review', limitReason: 'Blocked' });
  f.send('producer', 'work.blocked', { workItemId: 'recipe-work', expectedRevision: 1, reason: 'Changed', nextAction: 'Inspect' });
  const before = f.store.room('commons').sequence;
  const stale = await f.post(command);
  assert.equal(stale.status, 409);
  assert.equal(f.store.room('commons').sequence, before);
  const current = (await f.read()).actionRecipes.find(action => action.tool === 'room_handoff');
  const fresh = fill(current, { requestId: randomUUID(), doneSummary: 'Partial', nextAction: 'Review', limitReason: 'Blocked' });
  f.send('owner', 'member.access_changed', { memberId: 'producer', expectedMemberRevision: f.store.room('commons').state.members.producer.revision,
    permissions: [], active: true });
  const revokedSequence = f.store.room("commons").sequence;
  assert.equal((await f.post(fresh)).status, 403);
  assert.equal(f.store.room("commons").sequence, revokedSequence);
  assert.equal((await f.read()).actionRecipes.some(action => action.tool === 'room_handoff'), false);
  assert.equal(f.store.room('commons').state.workItems['recipe-work'].handoff, undefined);
});

test('halted members receive no claim recipes, while handoff remains a triage option', async t => {
  const f = await fixture(t), context = await f.read();
  const handoff = context.actionRecipes.find(action => action.tool === 'room_handoff');
  const response = await f.post(fill(handoff, { requestId: randomUUID(), doneSummary: 'Not started', nextAction: 'Owner triage', limitReason: 'Pause all work', haltAll: true }));
  assert.equal(response.status, 201);
  const before = f.store.room('commons').sequence;
  const halted = await f.read();
  assert.equal(f.store.room('commons').sequence, before, 'recipes do not mutate or dispatch');
  assert.deepEqual(halted.actionRecipes.map(action => action.tool), ['room_handoff']);
});

test('claim and handoff discovery exposes descriptor transport metadata without parsing prose', () => {
  for (const name of ['room_claim', 'room_handoff']) {
    const local = workTools.find(tool => tool.name === name), hosted = hostedStdioToolDefinitions().find(tool => tool.name === name);
    assert.deepEqual(hosted._meta, local._meta);
    const found = searchActions(name, { tools: [{ ...hosted, description: 'No route in this description.' }] }).matches[0];
    assert.equal(found.rest, 'POST /api/rooms/{roomId}/commands');
    assert.deepEqual(found.transport, local._meta['project-room/transport']);
  }
});


test('work contract revision follows actual schemas and structured metadata, not display prose or catalog order', () => {
  assert.equal(workActionContractRevision([...workTools].reverse()), WORK_ACTION_CONTRACT_REVISION);
  const prose = structuredClone(workTools); prose[0].description = 'Changed explanatory copy';
  assert.equal(workActionContractRevision(prose), WORK_ACTION_CONTRACT_REVISION);
  const schema = structuredClone(workTools); schema[0].inputSchema.properties.requestId.maxLength--;
  assert.notEqual(workActionContractRevision(schema), WORK_ACTION_CONTRACT_REVISION);
  const transport = structuredClone(workTools); transport[0]._meta['project-room/transport'].http.commandType = 'future.command';
  assert.notEqual(workActionContractRevision(transport), WORK_ACTION_CONTRACT_REVISION);
});

test('hosted MCP can list and execute the explicitly room-scoped selected recipe', async t => {
  const f = await fixture(t);
  const { AgentRooms } = await import('../server/agent-rooms.mjs');
  const owner = f.store.identities.create('Recipe owner'), roomId = 'hosted-recipes';
  new AgentRooms(f.store).create(owner.secret, { roomId, title: 'Hosted recipes', purpose: 'Test', kind: 'personal' });
  const send = (type, data) => f.store.command(owner.secret, roomId, { id: randomUUID(), type, data });
  send('work.proposed', { workItemId: 'hosted-work', title: 'Test', definitionOfDone: 'Test', accountableMemberId: owner.identityId, mode: 'write' });
  send('work.accepted', { workItemId: 'hosted-work', expectedRevision: 0 });
  const rpc = async (method, params) => {
    const response = await fetch(f.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${owner.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.error, undefined, JSON.stringify(value));
    assert.notEqual(value.result.isError, true, JSON.stringify(value)); return value.result;
  };
  const catalog = (await rpc('tools/list', { profile: 'full' })).tools;
  const context = (await rpc('tools/call', { name: 'room_read_work', arguments: { roomId, workItemId: 'hosted-work' } })).structuredContent;
  assert.equal(context.workActionContractRevision, WORK_ACTION_CONTRACT_REVISION);
  const recipe = context.actionRecipes.find(action => action.arguments.action === 'take');
  const args = { ...recipe.hostedMcp.arguments, requestId: randomUUID(), repository: 'test/repo', ref: 'main', paths: ['hosted/**'], expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const schema = catalog.find(tool => tool.name === recipe.hostedMcp.tool).inputSchema;
  assert.equal(conforms(args, schema), true, 'hosted roomId is required and included');
  assert.equal(conforms({ ...recipe.arguments, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'roomId')) }, schema), false);
  const recorded = (await rpc('tools/call', { name: recipe.hostedMcp.tool, arguments: args })).structuredContent;
  assert.equal(recorded.status, 'recorded');
  const verified = (await rpc('tools/call', { name: recipe.hostedMcp.verify.tool, arguments: recipe.hostedMcp.verify.arguments })).structuredContent;
  assert.equal(verified.work.claim.holderId, owner.identityId);
});
