import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { createRoomServer } from '../server/http.mjs';
import { applyEvent, event } from '../src/events.js';
import { validAutomationRequest } from '../src/automation-policy.js';

function setup(t, filename = ':memory:', agentCreator = false) {
  let now = Date.parse('2026-09-12T00:00:00.000Z');
  const store = new RoomStore(filename, { now: () => now }); t.after(() => store.close());
  store.initialize(initialRoom());
  let owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'member', type: 'member.added', data: { memberId: 'agent', kind: 'agent', displayName: 'Agent', permissions: [] } });
  const agent = store.issueAccessKey('commons', 'agent');
  if (agentCreator) {
    store.command(owner, 'commons', { id: 'peer', type: 'member.added', data: { memberId: 'peer', kind: 'agent', displayName: 'Peer', permissions: [] } });
    owner = store.issueAccessKey('commons', 'peer');
  }
  const definition = { title: 'Check', prompt: 'What changed?', recipientId: 'agent', trigger: { kind: 'interval', intervalMs: 60000, startAt: '2026-09-12T00:00:00.000Z' }, maxRuns: 2, maxRuntimeMs: 10000, maxOutputBytes: 4096 };
  for (const [type, revision, key] of [['created', 0, owner], ['enabled', 1, owner], ['accepted', 2, agent]]) store.command(key, 'commons', {
    id: type, type: `automation.${type}`, data: { automationId: 'daily', expectedRevision: revision, ...(type === 'created' ? { definition } : {}) }
  });
  const dispatch = { id: 'dispatch', type: 'message.posted', data: { messageId: 'q', automationId: 'daily', automationRevision: 3, automationSlot: 0 } };
  return { store, owner, agent, dispatch, advance: milliseconds => { now += milliseconds; } };
}

test('dispatch derives a native chat request atomically and exact retry survives pause/restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'room.sqlite'), f = setup(t, filename);
  const receipt = f.store.command(f.owner, 'commons', f.dispatch), state = f.store.room('commons').state;
  assert.equal(receipt.event.type, 'message.posted');
  assert.equal(receipt.event.data.body, 'What changed?');
  assert.equal(state.messages.length, 1);
  assert.equal(state.replyRequests.q.automation.maxRuntimeMs, 10000);
  assert.equal(state.automations.daily.dispatchCount, 1);
  assert.equal(state.automations.daily.lastRequestId, 'q');
  assert.deepEqual(state.workItems, {});
  f.store.command(f.agent, 'commons', { id: 'pause', type: 'automation.paused', data: { automationId: 'daily', expectedRevision: 4 } });
  assert.equal(f.store.command(f.owner, 'commons', f.dispatch).event.id, receipt.event.id);
  const reopened = new RoomStore(filename); t.after(() => reopened.close());
  assert.equal(reopened.command(f.owner, 'commons', f.dispatch).duplicate, true);
  assert.equal(reopened.room('commons').state.automations.daily.dispatchCount, 1);
  assert.equal(auditRecovery(reopened).schemaVersion, 33);
});

test('forged scope, duplicate message and rejected posts consume neither slot nor budget', t => {
  const f = setup(t), before = f.store.room('commons');
  for (const extra of [{ body: 'Injected' }, { toMemberId: 'owner' }, { requestKind: 'reply' }, { maxRuntimeMs: 999999 }, { automationRevision: 0 }, { automationSlot: 5 }])
    assert.throws(() => f.store.command(f.owner, 'commons', { ...f.dispatch, data: { ...f.dispatch.data, ...extra } }));
  assert.throws(() => f.store.command(f.agent, 'commons', f.dispatch));
  assert.deepEqual(f.store.room('commons'), before);
  f.store.command(f.owner, 'commons', { id: 'ordinary', type: 'message.posted', data: { messageId: 'q', body: 'Ordinary chat' } });
  assert.throws(() => f.store.command(f.owner, 'commons', f.dispatch));
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 0);
  const payload = { messageId: 'other', body: 'Forged', requestKind: 'reply', toMemberId: 'agent', workItemId: null, automationId: 'daily', automationRevision: 3, automationSlot: 0, requestPolicyVersion: 1 };
  assert.throws(() => applyEvent(before.state, event({ type: 'message.posted', roomId: 'commons', actorId: 'owner', at: '2026-09-12T00:00:00.000Z', data: payload })), /accepted scope/);
  assert.deepEqual(f.store.room('commons').state.workItems, {});
});

test('accepted runtime/output limits constrain claims and missed slots never catch up', t => {
  const f = setup(t), receipt = f.store.command(f.owner, 'commons', f.dispatch);
  const claim = { id: 'claim', type: 'request_run.claimed', data: { requestMessageId: 'q', expectedRevision: 0, runId: 'run', contextEventId: receipt.event.id, instructionsRevision: 0, maxRuntimeMs: 10000, maxOutputBytes: 4096 } };
  for (const extra of [{ maxRuntimeMs: 10001 }, { maxOutputBytes: 4097 }]) assert.throws(() => f.store.command(f.agent, 'commons', { ...claim, data: { ...claim.data, ...extra } }), /accepted automation limits/);
  f.store.command(f.agent, 'commons', claim);
  f.store.command(f.owner, 'commons', { id: 'cancel', type: 'reply_request.cancelled', data: { requestMessageId: 'q', expectedRequestRevision: 0, reason: 'No longer needed' } });
  f.advance(600000);
  const next = { id: 'next', type: 'message.posted', data: { messageId: 'q2', automationId: 'daily', automationRevision: 4, automationSlot: 10 } };
  assert.throws(() => f.store.command(f.owner, 'commons', next));
  f.store.command(f.agent, 'commons', { id: 'finish', type: 'request_run.finished', data: { requestMessageId: 'q', expectedRevision: 1, runId: 'run', status: 'cancelled' } });
  assert.throws(() => f.store.command(f.owner, 'commons', { ...next, data: { ...next.data, automationSlot: 1 } }));
  f.store.command(f.owner, 'commons', next);
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 2);
  assert.equal(f.store.room('commons').state.messages.length, 2);
  assert.equal(auditRecovery(f.store).schemaVersion, 33);
});

test('competing HTTP dispatchers create only one request', async t => {
  const f = setup(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = command => fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/commands`, { method: 'POST', headers: { authorization: `Bearer ${f.owner}`, 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const commands = [f.dispatch, { ...f.dispatch, id: 'other', data: { ...f.dispatch.data, messageId: 'other' } }];
  const results = await Promise.all(commands.map(post));
  assert.equal(results.filter(result => result.ok).length, 1);
  const winner = results.findIndex(result => result.ok);
  assert.equal((await (await post(commands[winner])).json()).duplicate, true);
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 1);
  assert.equal(f.store.room('commons').state.messages.length, 1);
});

test('matching forged projection and checkpoint cannot hide altered automation limits or count', t => {
  const f = setup(t); f.store.command(f.owner, 'commons', f.dispatch);
  const { state, sequence } = f.store.room('commons');
  f.store.db.prepare('INSERT INTO projection_checkpoints VALUES(?,?,?)').run('commons', sequence, JSON.stringify(state));
  for (const mutate of [s => { s.automations.daily.dispatchCount = 0; }, s => { s.replyRequests.q.automation.maxRuntimeMs = 300000; }]) {
    const changed = structuredClone(state); mutate(changed);
    f.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(changed), 'commons');
    f.store.db.prepare('UPDATE projection_checkpoints SET projection=? WHERE room_id=?').run(JSON.stringify(changed), 'commons');
    assert.throws(() => auditRecovery(f.store), /Reply request history/);
  }
});

test('agent-to-agent dispatch records the real creator and strict accepted limits', t => {
  const f = setup(t, ':memory:', true), receipt = f.store.command(f.owner, 'commons', f.dispatch);
  assert.equal(receipt.event.actorId, 'peer');
  const request = f.store.room('commons').state.replyRequests.q;
  assert.equal(request.requesterId, 'peer'); assert.equal(request.recipientId, 'agent');
  assert.equal(validAutomationRequest(request.automation), true);
  for (const bad of [{ ...request.automation, extra: true }, { ...request.automation, maxRuntimeMs: 0 }, { ...request.automation, slot: -1 }, null])
    assert.equal(validAutomationRequest(bad), false);
  assert.equal(auditRecovery(f.store).schemaVersion, 33);
});
