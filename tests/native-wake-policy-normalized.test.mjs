import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event, EVENT_TYPES as T} from '../src/events.js';
import {authorizeNativeEvent} from '../server/mcp-events-runtime.mjs';

// dm, work, board and directed native wakes have no canonical mention context,
// so policy fell back to store.room(), which refuses normalized rooms (409).
// The same decisions must come out of a legacy and a normalized room.
function room(t, representation) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const log = initialRoom();
  const add = (memberId, kind, extra = {}) => log.push(event({roomId: 'commons', actorId: 'owner', type: T.MEMBER_ADDED, data: {memberId, displayName: memberId, kind, permissions: ['steer'], ...extra}}));
  add('agent', 'agent');
  add('peer', 'agent');
  add('quiet', 'agent');
  log.push(event({roomId: 'commons', actorId: 'owner', type: T.WORK_PROPOSED, data: {workItemId: 'task', title: 'Task', definitionOfDone: 'D', accountableMemberId: 'agent', mode: 'read'}}));
  s.initialize(log, representation ? {representation} : undefined);
  s.db.prepare("INSERT OR REPLACE INTO agent_talk_policies(room_id,member_id,policy,allowed_json,updated_by,updated_at) VALUES('commons','quiet','nobody','[]','owner',1)").run();
  return s;
}

const cases = [
  ['dm from owner', 'agent', {kind: 'dm', actorId: 'owner'}],
  ['dm from peer agent', 'agent', {kind: 'dm', actorId: 'peer'}],
  ['dm to an agent whose policy is nobody', 'quiet', {kind: 'dm', actorId: 'peer'}],
  ['self wake', 'agent', {kind: 'dm', actorId: 'agent'}],
  ['unknown actor', 'agent', {kind: 'dm', actorId: 'ghost'}],
  ['work wake at the current revision', 'agent', {kind: 'work', actorId: 'owner', workItemId: 'task', workRevision: 0}],
  ['work wake at a stale revision', 'agent', {kind: 'work', actorId: 'owner', workItemId: 'task', workRevision: 7}],
  ['work wake for a missing item', 'agent', {kind: 'work', actorId: 'owner', workItemId: 'nope', workRevision: 0}],
  ['unsupported kind', 'agent', {kind: 'other', actorId: 'owner'}]
];

test('native wake policy is the same for legacy and normalized rooms, and normalized never reads the whole room', t => {
  const legacy = room(t, null), normalized = room(t, 'normalized-current-v1');
  let wholeRoomReads = 0;
  const original = normalized.room.bind(normalized);
  normalized.room = (...args) => { wholeRoomReads++; return original(...args); };
  const decisions = [];
  for (const [name, memberId, context] of cases) {
    const descriptor = {roomId: 'commons', memberId, identityId: `identity-${memberId}`, scopes: ['work:read']};
    const input = {event: {name: 'room.requested', data: {roomId: 'commons', memberId}}, context};
    const before = authorizeNativeEvent(legacy, descriptor, input);
    const after = authorizeNativeEvent(normalized, descriptor, input);
    assert.equal(after, before, name);
    decisions.push([name, after]);
  }
  assert.equal(wholeRoomReads, 0, 'normalized policy used bounded reads only');
  // Guard against a vacuous pass: the table has both outcomes.
  assert.ok(decisions.some(([, allowed]) => allowed) && decisions.some(([, allowed]) => !allowed), JSON.stringify(decisions));
  assert.equal(Object.fromEntries(decisions)['dm from owner'], true);
  assert.equal(Object.fromEntries(decisions)['dm to an agent whose policy is nobody'], false);
});

// A message wake must not deliver over a corrupt or witnessed-but-missing
// message or channel: the legacy whole-room read throws there and the outbox
// keeps the delivery pending, so the normalized selected read must throw too.
function lift(s, table, change) {
  const guards = s.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table);
  for (const {name} of guards) s.db.exec(`DROP TRIGGER ${name}`);
  change();
  for (const {sql} of guards) s.db.exec(sql);
}
const tampers = {
  'message body forged': s => lift(s, 'messages', () => s.db.prepare("UPDATE messages SET body='forged' WHERE message_id='note'").run()),
  'message row removed': s => lift(s, 'messages', () => s.db.prepare("DELETE FROM messages WHERE message_id='note'").run()),
  'channel record forged': s => lift(s, 'current_room_records', () => s.db.prepare("UPDATE current_room_records SET payload=json_set(payload,'$.name','forged') WHERE domain='channels' AND record_key='general'").run()),
  'channel record removed': s => lift(s, 'current_room_records', () => s.db.prepare("DELETE FROM current_room_records WHERE domain='channels' AND record_key='general'").run())
};
for (const [name, tamper] of Object.entries(tampers)) test(`normalized message wake stays pending when ${name}`, t => {
  const s = room(t, 'normalized-current-v1');
  s.command(s.issueAccessKey('commons', 'owner'), 'commons', {id: 'note', type: T.MESSAGE_POSTED, data: {messageId: 'note', body: 'psst', toMemberId: 'agent'}});
  const descriptor = {roomId: 'commons', memberId: 'agent', identityId: 'identity-agent', scopes: []};
  for (const kind of ['dm', 'mention']) {
    const input = {event: {name: 'room.requested', data: {roomId: 'commons', memberId: 'agent', messageId: 'note'}}, context: {kind, actorId: 'owner'}};
    assert.equal(authorizeNativeEvent(s, descriptor, input), true, `${kind} delivers before the tamper`);
  }
  tamper(s);
  for (const kind of ['dm', 'mention']) {
    const input = {event: {name: 'room.requested', data: {roomId: 'commons', memberId: 'agent', messageId: 'note'}}, context: {kind, actorId: 'owner'}};
    assert.throws(() => authorizeNativeEvent(s, descriptor, input), /current_room_corrupt/, kind);
  }
});
