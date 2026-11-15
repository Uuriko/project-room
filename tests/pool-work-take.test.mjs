// Pool work: an unassigned item (work.proposed pool:true) that any accept_work
// holder takes with work.accepted take:true. Reuses the existing handoff and
// claim-lease facts to decide when an item is open again; no new queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {applyEvent, emptyRoomState, event, EVENT_TYPES as T} from '../src/events.js';
import {buildWorkCommand, validWorkArguments} from '../client/work-actions.mjs';

const T0 = Date.parse('2026-11-15T10:00:00.000Z');
function fixture(t, {representation = 'normalized-current-v1'} = {}) {
  let now = T0;
  const s = new RoomStore(':memory:', {now: () => now});
  t.after(() => s.close());
  s.initialize(initialRoom('commons', 'owner'), {representation});
  const ownerKey = s.issueAccessKey('commons', 'owner');
  const join = (name, profile = 'contribute', extra = {}) => {
    const issued = s.invites.create(ownerKey, 'commons', {profile, displayName: name, ...extra});
    const joined = s.invites.redeem(issued.code, {displayName: name});
    return {id: joined.memberId, key: joined.identitySecret};
  };
  const cmd = (key, id, type, data) => s.command(key, 'commons', {id, type, data});
  const item = id => JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE work_id=?').get(id).body);
  return {s, ownerKey, join, cmd, item, advance: ms => { now += ms; }, at: () => new Date(now).toISOString()};
}
const propose = (f, workItemId, extra = {}) => f.cmd(f.ownerKey, `p-${workItemId}`, 'work.proposed',
  {workItemId, title: `Pool ${workItemId}`, definitionOfDone: 'Done when reviewed', accountableMemberId: 'owner', pool: true, ...extra});

test('any accept_work holder takes an unassigned pool item and becomes accountable', t => {
  const f = fixture(t);
  const a = f.join('Agent A');
  propose(f, 'pool-1');
  assert.equal(f.item('pool-1').pool, true);
  assert.equal(f.item('pool-1').accountableMemberId, 'owner');
  const taken = f.cmd(a.key, 'take-1', 'work.accepted', {workItemId: 'pool-1', expectedRevision: 0, take: true});
  assert.ok(taken.event);
  const after = f.item('pool-1');
  assert.equal(after.state, 'accepted');
  assert.equal(after.accountableMemberId, a.id);
  assert.equal(after.takenFromId, 'owner');
  assert.equal(after.revision, 1);
  // The new holder continues through the ordinary path.
  f.cmd(a.key, 'start-1', 'work.started', {workItemId: 'pool-1', expectedRevision: 1});
  assert.equal(f.item('pool-1').state, 'working');
  assert.doesNotThrow(() => auditRecovery(f.s));
});

test('two takers race: the second is refused and the first keeps the item', t => {
  const f = fixture(t);
  const a = f.join('Agent A'), b = f.join('Agent B');
  propose(f, 'race');
  f.cmd(a.key, 'a-takes', 'work.accepted', {workItemId: 'race', take: true});
  assert.throws(() => f.cmd(b.key, 'b-takes', 'work.accepted', {workItemId: 'race', take: true}), /held|lease/i);
  assert.equal(f.item('race').accountableMemberId, a.id);
  // A stale expectedRevision is refused too.
  assert.throws(() => f.cmd(b.key, 'b-stale', 'work.accepted', {workItemId: 'race', expectedRevision: 0, take: true}), /Stale|held/i);
});

test('take is refused for non-pool items, without accept_work, and when held by yourself', t => {
  const f = fixture(t);
  const a = f.join('Agent A'), chat = f.join('Chat only', 'chat');
  f.cmd(f.ownerKey, 'plain', 'work.proposed', {workItemId: 'plain', title: 'Plain', definitionOfDone: 'x', accountableMemberId: 'owner'});
  assert.throws(() => f.cmd(a.key, 't-plain', 'work.accepted', {workItemId: 'plain', take: true}), /Only a pool item/);
  propose(f, 'pool-2');
  assert.throws(() => f.cmd(chat.key, 't-chat', 'work.accepted', {workItemId: 'pool-2', take: true}), /accept_work/);
  assert.throws(() => f.cmd(f.ownerKey, 't-self', 'work.accepted', {workItemId: 'pool-2', take: true}), /already hold/);
  assert.throws(() => f.cmd(a.key, 't-false', 'work.accepted', {workItemId: 'pool-2', take: false}), /take must be true/);
  assert.throws(() => f.cmd(a.key, 't-str', 'work.accepted', {workItemId: 'pool-2', take: 'yes'}), /Invalid field: take/);
  assert.equal(f.item('pool-2').accountableMemberId, 'owner');
  // Without take, the old rule still holds: only the accountable member accepts.
  assert.throws(() => f.cmd(a.key, 'plain-accept', 'work.accepted', {workItemId: 'pool-2'}), /accountable/i);
});

test('a pool item must be held by its proposer and pool must be a boolean', t => {
  const f = fixture(t);
  const a = f.join('Agent A');
  assert.throws(() => propose(f, 'bad-holder', {accountableMemberId: a.id}), /held by its proposer/);
  assert.throws(() => propose(f, 'bad-type', {pool: 'yes'}), /Invalid field: pool/);
  // pool:false is the same as omitted and stores no flag.
  propose(f, 'not-pool', {pool: false});
  assert.equal(f.item('not-pool').pool, undefined);
});

test('a held item stays held until the holder hands off, then the next taker gets it', t => {
  const f = fixture(t);
  const a = f.join('Agent A'), b = f.join('Agent B');
  propose(f, 'handoff');
  f.cmd(a.key, 'a-takes', 'work.accepted', {workItemId: 'handoff', take: true});
  f.cmd(a.key, 'a-start', 'work.started', {workItemId: 'handoff'});
  assert.throws(() => f.cmd(b.key, 'b-early', 'work.accepted', {workItemId: 'handoff', take: true}), /held/);
  f.cmd(a.key, 'a-handoff', 'work.handoff_recorded', {workItemId: 'handoff', doneSummary: 'Read half', nextAction: 'Finish the rest', limitReason: 'Out of context'});
  f.cmd(b.key, 'b-takes', 'work.accepted', {workItemId: 'handoff', take: true});
  const after = f.item('handoff');
  assert.equal(after.accountableMemberId, b.id);
  assert.equal(after.takenFromId, a.id);
  assert.equal(after.state, 'accepted');
  assert.equal(after.handoff.open, false);
  assert.doesNotThrow(() => auditRecovery(f.s));
});

test('write work returns to the pool when the holder lease lapses, and the taker needs a fresh claim', t => {
  const f = fixture(t);
  // Write authority is the taker's own: the item grant never follows the item.
  const a = f.join('Agent A', 'agent_member'), b = f.join('Agent B', 'agent_member');
  propose(f, 'write-1', {mode: 'write'});
  f.cmd(a.key, 'a-takes', 'work.accepted', {workItemId: 'write-1', take: true});
  const expiresAt = new Date(T0 + 10 * 60000).toISOString();
  f.cmd(a.key, 'a-claim', 'claim.acquired', {workItemId: 'write-1', repository: 'acme/app', ref: 'agent-a', paths: ['src/a.js'], expiresAt});
  assert.throws(() => f.cmd(b.key, 'b-early', 'work.accepted', {workItemId: 'write-1', take: true}), /held|lease/i);
  f.advance(11 * 60000);
  f.cmd(b.key, 'b-takes', 'work.accepted', {workItemId: 'write-1', take: true});
  const after = f.item('write-1');
  assert.equal(after.accountableMemberId, b.id);
  assert.equal(after.state, 'accepted');
  assert.throws(() => f.cmd(b.key, 'b-start', 'work.started', {workItemId: 'write-1'}), /claim/i);
  f.cmd(b.key, 'b-claim', 'claim.acquired', {workItemId: 'write-1', repository: 'acme/app', ref: 'agent-b', paths: ['src/a.js'], expiresAt: new Date(f.advance(0) ?? T0 + 30 * 60000).toISOString()});
});

test('the item write grant stamp does not follow a pool item to a taker without write authority', t => {
  const f = fixture(t);
  const a = f.join('Agent A', 'contribute'); // accept_work, complete_work; no write_external
  propose(f, 'write-2', {mode: 'write'});
  f.cmd(a.key, 'a-takes', 'work.accepted', {workItemId: 'write-2', take: true});
  assert.throws(() => f.cmd(a.key, 'a-start', 'work.started', {workItemId: 'write-2'}), /write_external|claim/i);
});

test('Trust off refuses a pool take across owners, like an assignment; Trust on allows it', t => {
  const f = fixture(t);
  f.cmd(f.ownerKey, 'bob', 'member.added', {memberId: 'bob', displayName: 'Dana Reyes', kind: 'human', permissions: []});
  f.cmd(f.ownerKey, 'bobbot', 'member.added', {memberId: 'bobbot', displayName: 'Quill', kind: 'agent', permissions: ['accept_work', 'complete_work'], accountableHumanId: 'bob'});
  const bobbot = f.s.issueAccessKey('commons', 'bobbot');
  propose(f, 'trust-pool');
  f.cmd(f.ownerKey, 'trust-off', 'room.trust_set', {enabled: false});
  assert.throws(() => f.cmd(bobbot, 'take-foreign', 'work.accepted', {workItemId: 'trust-pool', take: true}), /Trust is off/i);
  assert.equal(f.item('trust-pool').accountableMemberId, 'owner');
  f.cmd(f.ownerKey, 'trust-on', 'room.trust_set', {enabled: true});
  f.cmd(bobbot, 'take-trusted', 'work.accepted', {workItemId: 'trust-pool', take: true});
  assert.equal(f.item('trust-pool').accountableMemberId, 'bobbot');
});

test('independent verification: the named verifier cannot take the item it would review', t => {
  const f = fixture(t);
  const a = f.join('Agent A', 'collaborate');
  propose(f, 'verify-pool', {verifierMemberId: a.id, independentVerificationRequired: true});
  assert.throws(() => f.cmd(a.key, 'take-own-review', 'work.accepted', {workItemId: 'verify-pool', take: true}), /different accountable member and verifier/);
});

test('the work tools accept take and pool and build the command the reducer reads', () => {
  const command = buildWorkCommand('room_accept_work', {requestId: 'r1', workItemId: 'x', take: true});
  assert.deepEqual(command.data, {workItemId: 'x', take: true});
  assert.equal(validWorkArguments('room_accept_work', {workItemId: 'x'}), true);
  assert.equal(validWorkArguments('room_accept_work', {workItemId: 'x', take: 'yes'}), false);
  const proposal = {workItemId: 'y', title: 't', definitionOfDone: 'd', accountableMemberId: 'o', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false};
  assert.equal(validWorkArguments('room_propose_work', {...proposal, pool: true}), true);
  assert.equal(validWorkArguments('room_propose_work', proposal), true);
  assert.equal(validWorkArguments('room_propose_work', {...proposal, pool: 1}), false);
});

test('events recorded before the field replay unchanged: an item without pool cannot be taken', () => {
  let state = emptyRoomState();
  for (const recorded of initialRoom('r', 'o')) state = applyEvent(state, recorded);
  state = applyEvent(state, event({id: 'e-w', idempotencyKey: 'k-w', type: T.WORK_PROPOSED, actorId: 'o', roomId: 'r', at: '2026-11-15T10:00:00.000Z',
    data: {workItemId: 'w', title: 't', definitionOfDone: 'd', accountableMemberId: 'o'}}));
  assert.equal(state.workItems.w.pool, undefined);
  assert.equal(Object.hasOwn(state.workItems.w, 'takenFromId'), false);
  assert.throws(() => applyEvent(state, event({id: 'e-t', idempotencyKey: 'k-t', type: T.WORK_ACCEPTED, actorId: 'o', roomId: 'r', at: '2026-11-15T10:01:00.000Z',
    data: {workItemId: 'w', take: true}})), /Only a pool item/);
});

test('the work listing and context offer an open pool item as take, then as held after the take', t => {
  const f = fixture(t);
  const a = f.join('Agent A');
  propose(f, 'listed');
  const listed = f.s.currentWorkListing(a.key, 'commons', {}).work.find(row => row.id === 'listed');
  assert.equal(listed.next.action, 'take');
  assert.equal(listed.next.memberId, null);
  assert.equal(listed.next.needsAttention, false);
  f.cmd(a.key, 'take-listed', 'work.accepted', {workItemId: 'listed', take: true});
  const held = f.s.currentWorkListing(a.key, 'commons', {}).work.find(row => row.id === 'listed');
  assert.equal(held.next.action, 'start');
  assert.equal(held.next.memberId, a.id);
});
