import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { openMcpTestClient } from '../scripts/mcp-test-client.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { validateReplyRead, submitReplyAction, buildReplyCommand, validReplyArguments } from '../client/reply-actions.mjs';

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }), handles = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const h of handles) await h.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, config = { version: 1, origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer };
  const configDirectory = join(f.directory, 'private'); saveAgentConnection(configDirectory, config);
  f.store.command(f.keys.owner, 'commons', { id: 'automation', type: 'automation.created', data: { automationId: 'daily', expectedRevision: 0,
    definition: { title: 'Daily check', prompt: 'Selected prompt only', recipientId: 'producer', trigger: { kind: 'manual' }, maxRuns: 5, maxRuntimeMs: 10000, maxOutputBytes: 4096 } } });
  return { ...f, origin, config, configDirectory, client: new RoomAgentClient(config), handles };
}

test('bounded list omits prompt; selected human and agent preview has scoped actions and no writes', async t => {
  const f = await fixture(t), before = auditRecovery(f.store);
  const list = await f.client.replyRead('room_list_automations', {});
  assert.equal(list.automations.length, 1);
  assert.equal(JSON.stringify(list).includes('Selected prompt only'), false);
  assert.equal(Object.hasOwn(list.automations[0], 'definition'), false);
  const selected = await f.client.replyRead('room_preview_automation', { automationId: 'daily' });
  assert.equal(selected.automations[0].definition.prompt, 'Selected prompt only');
  assert.equal(selected.automations[0].actions.accept, true);
  assert.equal(selected.automations[0].actions.enable, false);
  assert.equal(selected.automations[0].backgroundDispatchEnabled, false);
  const human = f.store.automationRead(f.keys.owner, 'commons', 'daily');
  assert.equal(human.automations[0].actions.enable, true);
  assert.equal(human.automations[0].actions.accept, false);
  assert.deepEqual(auditRecovery(f.store), before);
});

test('preview follows consent and consumed slots without running or reserving', async t => {
  const f = await fixture(t);
  f.store.command(f.keys.owner, 'commons', { id: 'enable', type: 'automation.enabled', data: { automationId: 'daily', expectedRevision: 1 } });
  assert.equal(f.store.automationRead(f.keys.owner, 'commons', 'daily').automations[0].status, 'needs_recipient');
  f.store.command(f.keys.producer, 'commons', { id: 'accept', type: 'automation.accepted', data: { automationId: 'daily', expectedRevision: 2 } });
  const before = f.store.room('commons'), ready = f.store.automationRead(f.keys.owner, 'commons', 'daily').automations[0];
  assert.equal(ready.status, 'ready'); assert.equal(ready.nextSlot, 0); assert.equal(ready.actions.dispatch, true);
  assert.deepEqual(f.store.room('commons'), before);
  f.store.command(f.keys.owner, 'commons', { id: 'dispatch', type: 'message.posted', data: { messageId: 'q', automationId: 'daily', automationRevision: ready.revision, automationSlot: ready.nextSlot } });
  const after = f.store.automationRead(f.keys.owner, 'commons', 'daily').automations[0];
  assert.equal(after.status, 'in_flight'); assert.equal(after.lastRequestId, 'q'); assert.equal(after.remainingRuns, 4); assert.equal(after.nextSlot, null);
  assert.equal(after.actions.dispatch, false); assert.equal(after.actions.edit, false);
});

test('HTTP selection, revocation and client identity are fail-closed', async t => {
  const f = await fixture(t), get = (query, token = f.keys.producer) => fetch(`${f.origin}/api/rooms/commons/automations${query}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get('?automationId=daily')).status, 200);
  for (const query of ['?automationId=daily&automationId=daily', '?prompt=hidden', '?automationId=']) assert.equal((await get(query)).status, 422);
  assert.equal((await get('?automationId=missing')).status, 404);
  assert.equal((await get('', 'invalid')).status, 401);
  const session = f.store.createSession(f.keys.owner);
  const wrongBinding = await fetch(`${f.origin}/api/rooms/commons/automations?automationId=daily`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-session-binding': '0'.repeat(64) }
  });
  assert.equal(wrongBinding.status, 409);
  const changed = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!url.includes('/automations?')) return response;
    return Response.json({ ...await response.json(), viewerId: 'owner' });
  } });
  await assert.rejects(changed.replyRead('room_list_automations', {}), { code: 'identity_mismatch' });
  f.store.revoke(f.keys.producer);
  assert.equal((await get('?automationId=daily')).status, 401);
});

test('real MCP and CLI expose read-only automation previews without consuming a run', async t => {
  const f = await fixture(t), mcp = await openMcpTestClient(f.configDirectory); f.handles.push(mcp);
  const tools = (await mcp.request('tools/list')).result.tools.filter(tool => tool.name.includes('automation') && tool.annotations.readOnlyHint);
  assert.equal(tools.length, 2); assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  const before = auditRecovery(f.store);
  assert.equal((await mcp.call('room_preview_automation', { automationId: 'daily' })).result.structuredContent.automations[0].id, 'daily');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/agent-inbox.mjs', 'reply', 'room_list_automations'], { env: { ROOM_AGENT_CONFIG: f.configDirectory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.on('error', reject); child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; }); child.on('exit', code => resolve({ code, out, err })); child.stdin.end('{}');
  });
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).automations[0].id, 'daily');
  assert.deepEqual(auditRecovery(f.store), before);
});

test('malformed preview scope, extra fields, limits and selected identity are rejected', async t => {
  const f = await fixture(t), selected = await f.client.replyRead('room_preview_automation', { automationId: 'daily' });
  for (const mutate of [r => { r.scope.consumesSlot = true; }, r => { r.automations[0].definition.token = 'bad'; },
    r => { r.automations[0].definition.maxRuntimeMs = 999999; }, r => { r.automations[0].id = 'other'; },
    r => { r.automations[0].nextSlot = 0; }, r => { r.automations[0].backgroundDispatchEnabled = true; }]) {
    const changed = structuredClone(selected); mutate(changed);
    assert.throws(() => validateReplyRead(changed, { name: 'room_preview_automation', args: { automationId: 'daily' }, roomId: 'commons' }), { code: 'invalid_response' });
  }
});

test('agent automation lifecycle uses exact nested receipts and dispatch retries through MCP', async t => {
  const f = await fixture(t), mcp = await openMcpTestClient(f.configDirectory); f.handles.push(mcp);
  const definition = { title: 'Agent check', prompt: 'Review this', recipientId: 'owner', trigger: { kind: 'manual' }, maxRuns: 2, maxRuntimeMs: 10000, maxOutputBytes: 4096 };
  const create = { requestId: 'create-agent', automationId: 'agent-check', expectedRevision: 0, definition };
  const receipt = await f.client.replyAction('room_create_automation', create);
  assert.equal(receipt.status, 'recorded'); assert.equal(receipt.processStarted, false);
  assert.equal((await f.client.replyAction('room_create_automation', create)).duplicate, true);
  await f.client.replyAction('room_enable_automation', { requestId: 'enable-agent', automationId: 'agent-check', expectedRevision: 1 });
  await assert.rejects(f.client.replyAction('room_accept_automation', { requestId: 'forged-consent', automationId: 'agent-check', expectedRevision: 2 }));
  f.store.command(f.keys.owner, 'commons', { id: 'human-accept', type: 'automation.accepted', data: { automationId: 'agent-check', expectedRevision: 2 } });
  const run = { requestId: 'run-agent', automationId: 'agent-check', automationRevision: 3, automationSlot: 0, definition };
  const result = (await mcp.call('room_run_automation', run)).result.structuredContent;
  assert.equal(result.status, 'recorded'); assert.equal(result.processStarted, false);
  assert.equal(f.store.room('commons').state.replyRequests[result.requestMessageId].recipientId, 'owner');
  const paused = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/agent-inbox.mjs', 'reply', 'room_pause_automation'], { env: { ROOM_AGENT_CONFIG: f.configDirectory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.on('error', reject); child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; }); child.on('exit', code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify({ requestId: 'pause-agent', automationId: 'agent-check', expectedRevision: 4 }));
  });
  assert.equal(paused.code, 0, paused.err); assert.equal(JSON.parse(paused.out).status, 'recorded');
  assert.equal((await f.client.replyAction('room_run_automation', run)).duplicate, true);
  assert.equal(f.store.room('commons').state.automations['agent-check'].dispatchCount, 1);
  const corrupted = { command: async command => { const r = await f.client.command(command); r.event.data.body = 'different'; return r; } };
  const unknown = await submitReplyAction(corrupted, { roomId: 'commons', memberId: 'producer' }, 'room_run_automation', run);
  assert.equal(unknown.status, 'unconfirmed'); assert.equal(unknown.requestId, run.requestId);
  const wrongScope = await f.client.replyAction('room_run_automation', { ...run, definition: { ...definition, prompt: 'Wrong inspected scope' } });
  assert.equal(wrongScope.status, 'unconfirmed');
  assert.equal(f.store.room('commons').state.automations['agent-check'].dispatchCount, 1);
});

test('automation tools reject malformed definitions and do not send receipt evidence as a scope override', () => {
  const definition = { title: 'Check', prompt: 'Hi', recipientId: 'owner', trigger: { kind: 'manual' }, maxRuns: 2, maxRuntimeMs: 10000, maxOutputBytes: 4096 };
  const args = { requestId: 'run', automationId: 'a', automationRevision: 3, automationSlot: 0, definition };
  const command = buildReplyCommand({ roomId: 'commons', memberId: 'producer' }, 'room_run_automation', args);
  assert.deepEqual(Object.keys(command.data).sort(), ['automationId', 'automationRevision', 'automationSlot', 'messageId']);
  assert.equal(validReplyArguments('room_run_automation', { ...args, token: 'secret' }), false);
  assert.equal(validReplyArguments('room_run_automation', { ...args, definition: { ...definition, trigger: { kind: 'manual', intervalMs: 60000 } } }), false);
  assert.equal(validReplyArguments('room_create_automation', { requestId: 'new', automationId: 'a', expectedRevision: 1, definition }), false);
});
