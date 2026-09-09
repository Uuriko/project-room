// Scripted local clients and protocol processes, not native model participation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { openMcpTestClient } from '../scripts/mcp-test-client.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';

async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = actor => ({ origin, roomId: 'commons', token: f.keys[actor], ...(actor === 'owner' ? {} : { memberId: actor }) });
  const client = actor => new RoomAgentClient(config(actor));
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', { id: crypto.randomUUID(), type, data });
  const change = (actor, type, data = {}) => send(actor, type, { workItemId: 'test-handoff',
    expectedRevision: f.store.room('commons').state.workItems['test-handoff'].revision, ...data });
  const focused = async actor => {
    const before = auditRecovery(f.store).dataSha256;
    const result = await client(actor).orient({ focus: 'needs_me' });
    assert.equal(auditRecovery(f.store).dataSha256, before, 'reading never changes any application table');
    assert.equal(result.scope.externalExecution, false); return result;
  };
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return { ...f, config, client, send, change, focused };
}

test('focused work follows producer, reviewer and human decision handoffs without executing or marking read', async t => {
  const f = await setup(t);
  const proposed = await f.focused('producer');
  assert.equal(proposed.work.length, 1); assert.equal(proposed.work[0].next.action, 'accept');
  assert.deepEqual(proposed.work[0].availableRoomActions, [{ action: 'accept', label: 'Accept' }]);
  assert.deepEqual(proposed.work[0].nextRead, { tool: 'room_read_work', arguments: { workItemId: 'test-handoff' } });
  assert.equal((await f.focused('reviewer')).work.length, 0);
  f.change('producer', 'work.accepted');
  assert.equal((await f.focused('producer')).work[0].next.action, 'start');
  f.change('producer', 'work.started');
  assert.equal((await f.focused('producer')).work.length, 0, 'ongoing work is not another handoff');
  assert.equal((await f.client('producer').orient()).work.length, 1, 'full view still contains ongoing work');
  f.change('producer', 'work.blocked', { reason: 'Need clarification', nextAction: 'Ask the owner' });
  const blocked = (await f.focused('producer')).work[0];
  assert.equal(blocked.next.action, 'revise'); assert.ok(blocked.availableRoomActions.some(a => a.action === 'resolve'));
  f.change('producer', 'work.blocker_resolved', { resolution: 'Owner clarified the request' });
  f.change('producer', 'work.completed', { producerId: 'producer', summary: 'Synthetic agenda',
    evidenceUrl: 'https://example.invalid/agenda', evidenceVersion: 'v1', nextAction: 'Review' });
  assert.equal((await f.focused('producer')).work.length, 0);
  const review = (await f.focused('reviewer')).work[0];
  assert.equal(review.next.action, 'verify'); assert.equal(review.next.evidenceVersion, 'v1');
  const receipt = f.store.room('commons').state.workItems['test-handoff'].receipt;
  f.change('reviewer', 'verification.recorded', { result: 'pass', completionEventId: receipt.eventId,
    evidenceVersion: 'v1', summary: 'Checked synthetic evidence' });
  assert.equal((await f.focused('reviewer')).work.length, 0, 'optional repeat review is not a required next step');
  const decision = (await f.focused('owner')).work[0];
  assert.equal(decision.next.action, 'decide'); assert.ok(decision.availableRoomActions.some(a => a.action === 'decide'));
  assert.equal(f.store.room('commons').state.workItems['test-handoff'].decision, null, 'human decision remains pending');
});

test('focused view is concise, omits evidence/body fields and preserves the all-work default', async t => {
  const f = await setup(t);
  for (let n = 0; n < 12; n++) f.send('owner', 'work.proposed', { workItemId: `other-${n}`, title: `Other task ${n}`,
    definitionOfDone: 'Private detailed criteria '.repeat(30), accountableMemberId: 'owner',
    independentVerificationRequired: false, ownerDecisionRequired: false });
  const all = await f.client('producer').orient(), focused = await f.focused('producer');
  assert.equal(all.work.length, 13); assert.equal(focused.selection.totalWork, 13); assert.equal(focused.selection.needsMe, 1);
  assert.deepEqual((await f.client('producer').orient({ focus: 'all' })).work, all.work);
  for (const field of ['definitionOfDone', 'sourceMessageId', 'receipt', 'verification', 'decision', 'blocker', 'claim']) {
    assert.equal(Object.hasOwn(focused.work[0], field), false);
  }
  assert.ok(JSON.stringify(focused).length < JSON.stringify(all).length / 2);
  assert.equal(focused.clockSource, 'client'); assert.ok(Number.isFinite(Date.parse(focused.evaluatedAt)));
  assert.equal(JSON.stringify(focused).includes('Private detailed criteria'), false);
});

test('missing permission stays visible; revoked identity and invalid focus fail before work reads', async t => {
  const f = await setup(t);
  f.send('owner', 'member.access_changed', { memberId: 'producer', expectedMemberRevision: 0, active: true, permissions: [] });
  f.keys.producer = f.store.issueAccessKey('commons', 'producer');
  const blocked = await f.focused('producer');
  assert.equal(blocked.work[0].next.action, 'accept'); assert.deepEqual(blocked.work[0].availableRoomActions, []);
  let requests = 0;
  const invalid = new RoomAgentClient({ ...f.config('producer'), fetchImpl: () => { requests++; throw new Error(); } });
  for (const focus of ['mine', '', null, 1, {}]) await assert.rejects(invalid.orient({ focus }), { code: 'invalid_focus' });
  assert.equal(requests, 0);
  f.store.revoke(f.keys.producer);
  await assert.rejects(f.client('producer').orient({ focus: 'needs_me' }), { status: 401 });
});

test('write-scope expiry reappears as a handoff using one explicit client evaluation time', async t => {
  const f = await setup(t);
  f.send('owner', 'member.access_changed', { memberId: 'producer', expectedMemberRevision: 0, active: true,
    permissions: ['accept_work', 'complete_work', 'write_external'] });
  f.keys.producer = f.store.issueAccessKey('commons', 'producer');
  f.send('owner', 'work.proposed', { workItemId: 'write-task', title: 'Synthetic write scope', definitionOfDone: 'A reviewed note',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false, mode: 'write' });
  f.send('producer', 'work.accepted', { workItemId: 'write-task', expectedRevision: 0 });
  const now = Date.now(), expires = now + 60000;
  f.send('producer', 'claim.acquired', { workItemId: 'write-task', expectedRevision: 1,
    repository: 'project-room-test', ref: 'main', paths: ['notes/agenda.md'], expiresAt: new Date(expires).toISOString() });
  f.send('producer', 'work.started', { workItemId: 'write-task', expectedRevision: 2 });
  assert.equal((await f.focused('producer')).work.some(item => item.id === 'write-task'), false);
  t.mock.method(Date, 'now', () => expires + 1);
  const after = await f.focused('producer'), item = after.work.find(item => item.id === 'write-task');
  assert.equal(item.next.action, 'claim'); assert.ok(item.availableRoomActions.some(action => action.action === 'claim'));
  assert.equal(after.evaluatedAt, new Date(expires + 1).toISOString());
  assert.equal(f.store.room('commons').state.workItems['write-task'].claim.status, 'active', 'expiry read does not rewrite stored history');
});

test('real MCP and command-line next reuse the focused read; malformed selectors never act', async t => {
  const f = await setup(t), directory = join(f.directory, 'connection');
  saveAgentConnection(directory, { version: 1, ...f.config('producer') });
  const mcp = await openMcpTestClient(directory); t.after(() => mcp.close());
  const before = auditRecovery(f.store).dataSha256;
  const list = await mcp.request('tools/list');
  assert.equal(list.result.tools.length, 29);
  const tool = list.result.tools.find(tool => tool.name === 'room_list_work');
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await mcp.call('room_list_work', { focus: 'needs_me' });
  assert.equal(result.result.structuredContent.work[0].next.action, 'accept');
  for (const args of [{ focus: null }, { focus: 'execute' }, { focus: 'needs_me', start: true }]) {
    assert.equal((await mcp.call('room_list_work', args)).error.code, -32602);
  }
  const cli = await promisify(execFile)(process.execPath, ['scripts/agent-inbox.mjs', 'next'], {
    env: { ROOM_AGENT_CONFIG: directory }, timeout: 10000
  });
  assert.equal(JSON.parse(cli.stdout).focus, 'needs_me');
  assert.equal(JSON.parse(cli.stdout).work[0].nextRead.arguments.workItemId, 'test-handoff');
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/agent-inbox.mjs', 'next', 'extra'], {
    env: { ROOM_AGENT_CONFIG: directory }, timeout: 10000
  }), error => error.code === 1 && error.stderr.includes('usage_error'));
  assert.equal(auditRecovery(f.store).dataSha256, before);
});
