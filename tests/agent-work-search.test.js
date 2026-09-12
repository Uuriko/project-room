// Real local transport/processes with scripted inputs, not native AI reasoning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { searchWork } from '../src/work-selectors.js';
import { auditRecovery } from '../server/recovery.mjs';
import { openMcpTestClient } from '../scripts/mcp-test-client.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';

async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = actor => ({ origin, roomId: 'commons', token: f.keys[actor], memberId: actor });
  const client = actor => new RoomAgentClient(config(actor));
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', { id: crypto.randomUUID(), type, data });
  const propose = (id, title, owner = 'owner', done = 'Name the participant and next step.') => send('owner', 'work.proposed', {
    workItemId: id, title, definitionOfDone: done, accountableMemberId: owner, independentVerificationRequired: false, ownerDecisionRequired: false });
  const state = () => f.store.room('commons').state;
  const change = (id, type, data = {}) => send('producer', type, { workItemId: id, expectedRevision: state().workItems[id].revision, ...data });
  const read = async (query, focus = 'all') => {
    const before = auditRecovery(f.store).dataSha256, result = await client('producer').orient({ query, focus });
    assert.equal(auditRecovery(f.store).dataSha256, before, 'querying never changes any Room table'); return result;
  };
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return { ...f, config, client, send, propose, state, change, read };
}

test('agent search shares human matching, returns exact read pointers, and leaves default orientation unchanged', async t => {
  const f = await setup(t);
  f.propose('unicode', 'Café [notes] 🚀', 'producer', 'İ'.repeat(300) + 'needle');
  f.send('owner', 'message.posted', { messageId: 'not-work', body: 'message-only-query' });
  f.send('owner', 'room.charter_updated', { expectedRevision: 0, purpose: 'Synthetic context, not authority',
    outputs: 'Read before acting', boundaries: 'No external execution', escalation: null });
  const all = await f.client('producer').orient();
  assert.deepEqual((await f.client('producer').orient({ focus: 'all', query: undefined })).work, all.work);
  assert.equal(Object.hasOwn(all, 'selection'), false);
  for (const query of [' CAFÉ ', '🚀', '[notes]', 'needle', 'Test producer', 'unicode', 'message-only-query', '.*']) {
    const result = await f.read(query), expected = searchWork(f.state(), query);
    assert.deepEqual(result.work.map(work => work.id), expected.work.map(hit => hit.item.id));
    assert.deepEqual(result.work.map(work => work.excerpt), expected.work.map(hit => hit.excerpt));
    assert.equal(result.selection.query, query.trim()); assert.equal(result.selection.matches, expected.total);
    assert.equal(result.selection.shown, result.work.length); assert.equal(result.scope.externalExecution, false);
    assert.deepEqual(result.charter, all.charter); assert.deepEqual(result.member, all.member);
    assert.equal(result.clockSource, 'client'); assert.ok(Number.isFinite(Date.parse(result.evaluatedAt)));
    for (const row of result.work) {
      assert.deepEqual(row.nextRead, { tool: 'room_read_work', arguments: { workItemId: row.id } });
      for (const field of ['definitionOfDone', 'receipt', 'verification', 'decision', 'claim', 'blocker', 'sourceMessageId']) {
        assert.equal(Object.hasOwn(row, field), false);
      }
    }
  }
  const selected = (await f.read('CAFÉ')).work[0], before = auditRecovery(f.store).dataSha256;
  const context = await f.client('producer').workContext(selected.nextRead.arguments.workItemId);
  assert.equal(context.work.id, selected.id); assert.equal(context.work.revision, selected.revision);
  assert.equal(context.context.source.status, 'not_requested');
  assert.equal(auditRecovery(f.store).dataSha256, before);
});

test('agent query intersects focus before the 25-hit limit and preserves missing-permission assignments', async t => {
  const f = await setup(t);
  for (let index = 0; index < 30; index++) f.propose(`other-${index}`, `Agenda for another owner ${index}`);
  const all = await f.read('agenda');
  assert.equal(all.selection.matches, 31); assert.equal(all.selection.shown, 25); assert.equal(all.selection.hasMore, true);
  assert.equal(all.selection.eligibleWork, 31); assert.equal(all.selection.totalWork, 31);
  const selected = await f.read('agenda', 'needs_me');
  assert.equal(selected.selection.eligibleWork, 1); assert.equal(selected.selection.matches, 1);
  assert.equal(selected.selection.hasMore, false); assert.equal(selected.work[0].id, 'test-handoff');
  f.send('owner', 'member.access_changed', { memberId: 'producer', expectedMemberRevision: 0, active: true, permissions: [] });
  f.keys.producer = f.store.issueAccessKey('commons', 'producer');
  const missing = (await f.read('agenda', 'needs_me')).work[0];
  assert.equal(missing.next.action, 'accept'); assert.deepEqual(missing.availableRoomActions, []);
  const unchanged = await f.client('producer').orient({ focus: 'needs_me' });
  assert.deepEqual(unchanged.work[0].nextRead, missing.nextRead);
  assert.equal(Object.hasOwn(unchanged.work[0], 'excerpt'), false);
  assert.equal(unchanged.selection.needsMe, 1);
});

test('agent search finds completed outcomes but excludes replaced result text and never starts ongoing work', async t => {
  const f = await setup(t), id = 'earlier-outcome';
  f.propose(id, 'Prior observation', 'producer'); f.change(id, 'work.accepted'); f.change(id, 'work.started');
  assert.equal((await f.read('Prior observation', 'needs_me')).work.length, 0);
  assert.equal((await f.read('Prior observation')).work[0].state, 'working');
  const finish = summary => f.change(id, 'work.completed', { summary, evidenceUrl: 'https://example.invalid/not-fetched',
    evidenceVersion: crypto.randomUUID(), producerId: 'producer', nextAction: 'Consider follow-up' });
  finish('Historical-phrase in the reported result');
  const complete = await f.read('Historical-phrase'); assert.equal(complete.work[0].state, 'completed');
  assert.equal((await f.read('Historical-phrase', 'needs_me')).work.length, 0);
  f.change(id, 'work.blocked', { reason: 'Needs correction', nextAction: 'Prepare revised observation' });
  f.change(id, 'work.blocker_resolved', { resolution: 'Correction prepared' }); finish('Replacement-phrase in the current result');
  assert.equal((await f.read('Historical-phrase')).work.length, 0);
  assert.equal((await f.read('Replacement-phrase')).work[0].id, id);
  assert.equal(f.state().workItems[id].decision, null);
});

test('invalid search input fails before reads; cancellation and revocation retain the normal access boundary', async t => {
  const f = await setup(t); let reads = 0;
  const client = new RoomAgentClient({ ...f.config('producer'), fetchImpl: () => { reads++; throw new Error('must not read'); } });
  for (const query of ['', ' \n ', null, 12, {}, [], 'x'.repeat(201), '🚀'.repeat(101)]) {
    await assert.rejects(client.orient({ query }), { code: 'invalid_query' });
  }
  assert.equal(reads, 0);
  let ready; const started = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController(), before = auditRecovery(f.store).dataSha256;
  const delayed = new RoomAgentClient({ ...f.config('producer'), fetchImpl: (url, options) => {
    if (new URL(url).pathname.endsWith('/commons')) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); ready();
    });
    return fetch(url, options);
  } });
  const pending = delayed.orient({ query: 'agenda', signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await started; controller.abort(); await rejected;
  assert.equal(auditRecovery(f.store).dataSha256, before);
  f.store.revoke(f.keys.producer);
  await assert.rejects(f.client('producer').orient({ query: 'agenda' }), { status: 401 });
});

test('real MCP and CLI search use the shared projection with unchanged tool discovery and no Room writes', async t => {
  const f = await setup(t), directory = join(f.directory, 'connection');
  saveAgentConnection(directory, { version: 1, ...f.config('producer') });
  const mcp = await openMcpTestClient(directory); t.after(() => mcp.close());
  const before = auditRecovery(f.store).dataSha256, tools = (await mcp.request('tools/list')).result.tools;
  assert.equal(tools.length, 32);
  const tool = tools.find(tool => tool.name === 'room_list_work'); assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.properties.query.maxLength, 200); assert.deepEqual(tool.inputSchema.required, []);
  const response = await mcp.call('room_list_work', { query: 'agenda', focus: 'needs_me' });
  assert.equal(response.result.isError, undefined);
  const result = response.result.structuredContent;
  assert.deepEqual(JSON.parse(response.result.content[0].text), result);
  const context = (await mcp.call(result.work[0].nextRead.tool, result.work[0].nextRead.arguments)).result.structuredContent;
  assert.equal(context.work.id, 'test-handoff'); assert.equal(context.context.source.status, 'not_requested');
  for (const args of [{ query: '' }, { query: null }, { query: ' '.repeat(2) }, { query: 'x'.repeat(201) },
    { query: 'agenda', focus: 'mine' }, { query: 'agenda', start: true }]) {
    assert.equal((await mcp.call('room_list_work', args)).error.code, -32602);
  }
  for (const focus of [false, true]) {
    const cli = await promisify(execFile)(process.execPath, ['scripts/agent-inbox.mjs', 'search', 'agenda', ...(focus ? ['--needs-me'] : [])], {
      env: { ROOM_AGENT_CONFIG: directory }, timeout: 10000 });
    const output = JSON.parse(cli.stdout); assert.equal(cli.stderr, ''); assert.equal(output.focus, focus ? 'needs_me' : 'all');
    assert.equal(output.work[0].id, 'test-handoff'); assert.equal(output.selection.matches, 1);
  }
  assert.equal(auditRecovery(f.store).dataSha256, before);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/agent-work-search.json', JSON.stringify({ nativeModels: false, scriptedMcp: true,
    tools: tools.length, result, selected: { id: context.work.id, revision: context.work.revision, source: context.context.source.status },
    roomAuditUnchanged: true, audit: auditRecovery(f.store) }, null, 2));
});

test('invalid CLI searches fail before private configuration is loaded and never echo the query', async () => {
  const secret = 'synthetic-private-query';
  for (const args of [[], [''], ['   '], ['x'.repeat(201)], [secret, '--all'], [secret, '--needs-me', '--needs-me'], [secret, 'extra']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/agent-inbox.mjs', 'search', ...args], {
      env: { ROOM_AGENT_CONFIG: '/nonexistent-test-connection' }, timeout: 10000 }), error => {
      assert.equal(error.code, 1); assert.equal(JSON.parse(error.stderr).code, 'usage_error');
      assert.equal(error.stderr.includes(secret), false); assert.equal(error.stdout, ''); return true;
    });
  }
});
