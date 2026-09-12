import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionAutomation, automationDue, automationInFlight, automationPreview, validAutomationPreview } from '../src/automation-policy.js';
const now = '2026-09-12T22:00:00.000Z', later = '2026-09-12T22:10:00.000Z';
const members = { alice: { active: true, kind: 'human' }, bot: { active: true, kind: 'agent' }, peer: { active: true, kind: 'agent' }, owner: { active: true, kind: 'human' } };
const definition = { title: 'Brief', prompt: 'Summarize the supplied update', recipientId: 'bot', trigger: { kind: 'interval', startAt: now, intervalMs: 60000 }, maxRuns: 2, maxRuntimeMs: 30000, maxOutputBytes: 4096 };
const change = (automation, actorId, action, data = {}, extra = {}, at = now) => transitionAutomation({ automation, actorId, members, roomOwnerId: 'owner', ...extra }, action, { expectedRevision: automation?.revision ?? 0, ...data }, at);
const create = (owner = 'alice', patch = {}) => change(null, owner, 'create', { automationId: 'brief', definition: { ...definition, ...patch } }).automation;
const ready = (owner = 'alice', patch = {}) => { let a = create(owner, patch); a = change(a, owner, 'enable').automation; return change(a, 'bot', 'accept').automation; };

test('preview distinguishes waiting, eligible, halted and unavailable without mutating a schedule', () => {
  const state = { room: { ownerId: 'owner' }, members: structuredClone(members), automations: { brief: ready('alice', { trigger: { kind: 'interval', startAt: later, intervalMs: 60000 } }) } };
  const before = structuredClone(state), waiting = automationPreview(state, 'brief', 'alice', now, true);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.nextDueAt, later); assert.equal(waiting.nextSlot, null);
  assert.equal(validAutomationPreview(waiting, true), true); assert.deepEqual(state, before);
  const eligible = automationPreview(state, 'brief', 'alice', '2026-09-12T22:13:00.000Z', true);
  assert.equal(eligible.status, 'ready'); assert.equal(eligible.nextSlot, 3); assert.equal(eligible.nextDueAt, '2026-09-12T22:13:00.000Z');
  state.agentHalts = { alice: { eventId: 'halt' } };
  assert.equal(automationPreview(state, 'brief', 'alice', later, true).status, 'halted');
  assert.equal(automationPreview(state, 'brief', 'alice', later, true).actions.dispatch, false);
  state.members.bot.active = false;
  const unavailable = automationPreview(state, 'brief', 'alice', later, true);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.actions.pause, true); assert.equal(unavailable.actions.accept, false);
});

test('human and agent authors need recipient consent; neither grants outside execution rights', () => {
  for (const owner of ['alice', 'peer']) {
    let a = create(owner); assert.equal(automationDue(a, { members }, now), null);
    a = change(a, owner, 'enable').automation; assert.equal(automationDue(a, { members }, now), null);
    assert.throws(() => change(a, owner, 'accept'), /another participant/);
    a = change(a, 'bot', 'accept').automation;
    const before = structuredClone(a), dispatched = change(a, owner, 'dispatch', { requestMessageId: 'q', slot: 0 });
    assert.deepEqual(a, before); assert.equal(dispatched.message.toMemberId, 'bot'); assert.equal(dispatched.message.workItemId, null);
    assert.equal(dispatched.automation.dispatchCount, 1);
    assert.equal(Object.hasOwn(dispatched.message, 'command'), false);
  }
});

test('pause revokes both approvals and scope changes require fresh consent', () => {
  for (const actor of ['alice', 'bot', 'owner']) {
    const a = change(ready(), actor, 'pause').automation;
    assert.equal(a.ownerEnabled, false); assert.equal(a.recipientAccepted, false);
    assert.equal(automationDue(a, { members }, now), null);
  }
  assert.throws(() => change(ready(), 'peer', 'pause'));
  assert.throws(() => change(create(), 'alice', 'pause'), /already paused/);
  const updated = change(ready(), 'alice', 'update', { definition: { ...definition, prompt: 'New scope' } }).automation;
  assert.equal(updated.recipientAccepted, false); assert.equal(updated.ownerEnabled, false);
  assert.throws(() => change(updated, 'bot', 'enable'));
});

test('missed intervals collapse to one latest slot with no catch-up burst', () => {
  let a = ready(); assert.deepEqual(automationDue(a, { members }, later), { slot: 10, kind: 'interval' });
  assert.throws(() => change(a, 'alice', 'dispatch', { requestMessageId: 'q', slot: 9 }, {}, later));
  a = change(a, 'alice', 'dispatch', { requestMessageId: 'q', slot: 10 }, {}, later).automation;
  const closed = { q: { status: 'answered' } };
  assert.equal(automationDue(a, { members, requests: closed }, later), null);
  const next = '2026-09-12T22:11:00.000Z';
  a = change(a, 'alice', 'dispatch', { requestMessageId: 'q2', slot: 11 }, { requests: closed }, next).automation;
  assert.equal(automationDue(a, { members, requests: { ...closed, q2: { status: 'answered' } } }, '2026-09-12T23:00:00.000Z'), null);
});

test('cancelled request with unknown execution still blocks new dispatch and edits', () => {
  const a = change(ready(), 'alice', 'dispatch', { requestMessageId: 'q', slot: 0 }).automation;
  for (const status of ['running', 'stop_requested', 'unknown']) {
    const extra = { requests: { q: { status: 'cancelled' } }, runs: { q: { status } } };
    assert.equal(automationInFlight(a, extra.requests, extra.runs), true);
    assert.equal(automationDue(a, { members, ...extra }, later), null);
    assert.throws(() => change(a, 'alice', 'update', { definition }, extra));
  }
  assert.equal(automationInFlight(a, {}, {}), true, 'missing predecessor is not proof of completion');
  assert.equal(automationInFlight(a, { q: { status: 'unknown' } }, {}), true);
  assert.equal(automationInFlight(a, { q: { status: 'answered' } }, {}), false);
});

test('manual dispatch is explicit and stale, forged, revoked or malformed choices fail', () => {
  const a = ready('alice', { trigger: { kind: 'manual' } });
  assert.deepEqual(automationDue(a, { members }, now), { slot: 0, kind: 'manual' });
  assert.throws(() => change(a, 'peer', 'dispatch', { requestMessageId: 'q', slot: 0 }));
  assert.throws(() => change(a, 'alice', 'dispatch', { requestMessageId: 'q', slot: 0, expectedRevision: 0 }));
  assert.throws(() => change(a, 'alice', 'dispatch', { requestMessageId: 'q', slot: 0, body: 'Overridden scope' }));
  assert.equal(automationDue(a, { members: { ...members, bot: { active: false, kind: 'agent' } } }, now), null);
  for (const patch of [{ maxRuns: 0 }, { maxRuntimeMs: 300001 }, { prompt: ' ' }, { trigger: { kind: 'interval', startAt: now, intervalMs: 1 } }, { recipientId: 'alice' }])
    assert.throws(() => create('alice', patch));
});
