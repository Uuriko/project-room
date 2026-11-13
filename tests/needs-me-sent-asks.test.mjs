// The asker learns in its own inbox read when an ask it sent needs it:
// unacknowledged past the ack window, stale, waiting on its input, or errored.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {collectNeedsMe} from '../server/needs-me.mjs';
import {ACK_WINDOW_MS, STALE_AFTER_MS} from '../server/request-states.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const olive = store.identities.create('Olive'), parker = store.identities.create('Parker'), roomId = 'sent-asks';
  new AgentRooms(store).create(olive.secret, {roomId, title: 'Sent asks', purpose: 'Synthetic test', starter: false});
  store.invites.redeem(store.invites.create(olive.secret, roomId, {profile: 'member'}).code,
    {identitySecret: parker.secret, displayName: 'Parker'});
  store.dmConsents.request(roomId, parker.identityId, olive.identityId, 'Reply coordination');
  store.dmConsents.decide(roomId, olive.identityId, parker.identityId, 'approve');
  store.command(parker.secret, roomId, {id: 'ask', type: 'message.posted',
    data: {messageId: 'ask', toMemberId: olive.identityId, requestKind: 'reply', body: 'Please check deployment'}});
  const realNow = Date.now; t.after(() => { Date.now = realNow; });
  const later = ms => { Date.now = () => realNow() + ms; };
  const sent = who => collectNeedsMe(store, who.secret, {roomId}).sentAsks ?? [];
  const progress = (id, progress, note) => store.command(olive.secret, roomId, {id, type: 'reply_request.progressed',
    data: {requestMessageId: 'ask', expectedRequestRevision: 0, progress, ...(note ? {note} : {})}});
  return {store, roomId, olive, parker, later, sent, progress};
}

test('an unacknowledged ask reaches the asker after the ack window, with read and cancel next steps', t => {
  const {roomId, olive, parker, later, sent} = fixture(t);
  assert.deepEqual(sent(parker), [], 'inside the ack window the asker is not told anything');
  later(ACK_WINDOW_MS + 1000);
  const [item, ...rest] = sent(parker);
  assert.equal(rest.length, 0);
  assert.deepEqual([item.id, item.roomId, item.recipientId, item.reason], ['ask', roomId, olive.identityId, 'unresponsive']);
  assert.deepEqual(item.next, {tool: 'room_read_request', arguments: {roomId, requestMessageId: 'ask'}});
  assert.deepEqual(item.cancel, {tool: 'room_cancel_request', arguments: {roomId, requestMessageId: 'ask', expectedRequestRevision: 0}, requiredInput: ['reason']});
  assert.deepEqual(sent(olive), [], 'the recipient is not told about an ask it received; that stays a direct_ask item');
});

test('acknowledgement clears it; needs_input, error and stale bring it back with the reason', t => {
  const {parker, later, sent, progress} = fixture(t);
  later(ACK_WINDOW_MS + 1000);
  assert.equal(sent(parker)[0].reason, 'unresponsive');
  progress('p1', 'acknowledged');
  assert.deepEqual(sent(parker), [], 'an acknowledged, active ask needs nothing from the asker');
  progress('p2', 'needs_input', 'Which environment?');
  assert.deepEqual([sent(parker)[0].reason, sent(parker)[0].note], ['needs_input', 'Which environment?']);
  progress('p3', 'error', 'No deploy access');
  assert.equal(sent(parker)[0].reason, 'error');
  progress('p4', 'working');
  assert.deepEqual(sent(parker), []);
  later(STALE_AFTER_MS + 60_000);
  assert.equal(sent(parker)[0].reason, 'stale');
});

test('an answered or cancelled ask is never listed, and the section is absent when empty', t => {
  const {store, roomId, olive, parker, later} = fixture(t);
  later(ACK_WINDOW_MS + 1000);
  store.command(parker.secret, roomId, {id: 'cancel', type: 'reply_request.cancelled',
    data: {requestMessageId: 'ask', expectedRequestRevision: 0, reason: 'No longer needed'}});
  const page = collectNeedsMe(store, parker.secret, {roomId});
  assert.equal('sentAsks' in page, false);
  assert.equal('sentAsks' in collectNeedsMe(store, olive.secret, {roomId}), false);
});

test("a runner's claimed attempt is the acknowledgement: the ask stops reading unresponsive", t => {
  const {store, roomId, olive, parker, later, sent} = fixture(t);
  later(ACK_WINDOW_MS + 1000);
  const state = () => store.replyRequests.list(parker.secret, roomId, {direction: 'outgoing', status: 'open', states: true}).requests[0].lifecycle;
  assert.deepEqual([state().state, state().unresponsive], ['pending', true]);
  const request = store.replyRequests.list(olive.secret, roomId).requests[0];
  store.requestRuns.apply(olive.secret, roomId, {requestMessageId: 'ask', attemptId: 'attempt-1', action: 'claim',
    expectedRequestRevision: request.revision, contextEventId: request.contextEventId});
  assert.deepEqual([state().state, state().unresponsive], ['active', false]);
  assert.equal(typeof state().since, 'string');
  assert.deepEqual(sent(parker), [], 'a picked-up ask no longer needs the asker');
  assert.equal('lifecycle' in store.replyRequests.list(parker.secret, roomId, {direction: 'outgoing'}).requests[0], false, 'default shape unchanged');
});
