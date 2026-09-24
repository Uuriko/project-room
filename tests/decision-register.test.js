// Decision register (backlog F2): a suggestion becomes policy only through an
// explicit, source-backed decision.recorded event from a human with decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { setTier } from '../server/autonomy-tiers.mjs';

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-decisions-'));
  const filename = join(directory, 'room.sqlite');
  const store = new RoomStore(filename, { now: () => Date.now() });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  for (const id of ['agent-a', 'viewer']) {
    store.command(keys.owner, 'commons', command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: id === 'agent-a' ? 'agent' : 'human', accountableHumanId: 'owner',
      permissions: id === 'viewer' ? [] : ['accept_work', 'complete_work'] }));
    keys[id] = store.issueAccessKey('commons', id);
  }
  // #953: new agent members default to t1_readonly; agent-a needs t2_standard so the decide-permission
  // denial (not the tier denial) is what the negative tests verify
  setTier(store.db, 'commons', 'agent-a', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  store.command(keys.owner, 'commons', command(T.MESSAGE_POSTED, { messageId: 'msg-1', body: 'We should freeze the copy on Fridays.' }));
  const decisions = () => store.eventsAfter(keys.owner, 'commons', 0).events.filter(e => e.event.type === T.DECISION_RECORDED);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { store, keys, decisions };
}

test('a human with decide promotes a message into a source-backed decision record', t => {
  const { store, keys, decisions } = fixture(t);
  store.command(keys.owner, 'commons', command(T.DECISION_RECORDED, {
    sourceMessageId: 'msg-1', statement: 'Copy freezes on Fridays.', note: 'Pilot policy'
  }));
  const recorded = decisions();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].event.data.sourceMessageId, 'msg-1');
  assert.equal(recorded[0].event.data.statement, 'Copy freezes on Fridays.');
  assert.equal(recorded[0].event.actorId, 'owner');
  assert.ok(Number.isSafeInteger(recorded[0].sequence));
  // The record changes no work-item projection state.
  assert.deepEqual(store.room('commons').state.workItems, {});
});

test('agents and members without decide cannot record decisions', t => {
  const { store, keys, decisions } = fixture(t);
  assert.throws(() => store.command(keys['agent-a'], 'commons', command(T.DECISION_RECORDED, {
    sourceMessageId: 'msg-1', statement: 'Agents self-authorize policy.' })), /lacks decide/);
  assert.throws(() => store.command(keys.viewer, 'commons', command(T.DECISION_RECORDED, {
    sourceMessageId: 'msg-1', statement: 'Viewers set policy.' })), /lacks decide/);
  assert.equal(decisions().length, 0);
});

test('decide permission delegation follows #643 owner-grant rules', t => {
  const { store, keys, decisions } = fixture(t);
  // #643: the owner may delegate decide to a non-owner agent (stamped delegatedAdmin);
  // non-owners still cannot. The old "cannot be delegated at all" rule is superseded.
  store.command(keys.owner, 'commons', command(T.MEMBER_ADDED, {
    memberId: 'agent-b', displayName: 'agent-b', kind: 'agent', accountableHumanId: 'owner', permissions: ['decide'] }));
  const member = store.room('commons').state.members['agent-b'];
  assert.equal(member.delegatedAdmin, true);
  assert.ok(member.permissions.includes('decide'));
  // A non-owner (viewer) cannot grant decide to an agent.
  assert.throws(() => store.command(keys.viewer, 'commons', command(T.MEMBER_ADDED, {
    memberId: 'agent-c', displayName: 'agent-c', kind: 'agent', accountableHumanId: 'owner', permissions: ['decide'] })), /cannot be delegated|lacks manage_members|access_denied|owner_required/);
  assert.equal(decisions().length, 0);
});

test('a decision must cite an exact existing message and bounded text', t => {
  const { store, keys, decisions } = fixture(t);
  for (const [data, pattern] of [
    [{ sourceMessageId: 'ghost', statement: 'Cites nothing real.' }, /reference a message/],
    [{ sourceMessageId: 'msg-1' }, /missing statement/],
    [{ sourceMessageId: 'msg-1', statement: '   ' }, /Invalid statement|missing statement/],
    [{ sourceMessageId: 'msg-1', statement: ' padded ' }, /trimmed/],
    [{ sourceMessageId: 'msg-1', statement: 'x'.repeat(501) }, /500/]
  ]) {
    assert.throws(() => store.command(keys.owner, 'commons', command(T.DECISION_RECORDED, data)), pattern);
  }
  assert.equal(decisions().length, 0);
});

test('decision commands are idempotent by command id', t => {
  const { store, keys, decisions } = fixture(t);
  const once = command(T.DECISION_RECORDED, { sourceMessageId: 'msg-1', statement: 'Copy freezes on Fridays.' });
  store.command(keys.owner, 'commons', once);
  store.command(keys.owner, 'commons', once);
  assert.equal(decisions().length, 1);
});
