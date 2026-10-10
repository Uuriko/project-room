// wake-reaction-ack: a reaction is the acknowledgment the wake payload promises.
// WAKE_ACK_HINT says "react 👍 to acknowledge" — before this fix, reacting to a
// message did nothing to the reacting member's pending wake signals, so the
// same signal re-appeared on every heartbeat poll (the phantom re-wake loop).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';

function fixture() {
  const store = new RoomStore(':memory:');
  const owner = store.identities.create('Wake owner');
  new AgentRooms(store).create(owner.secret, { roomId: 'wake-room', title: 'Wake', purpose: 'reaction ack' });
  const one = store.identities.create('Agent One');
  store.identities.link(owner.secret, 'wake-room', { identityId: one.identityId, memberId: 'agent-one', displayName: 'Agent One', permissions: [] });
  const two = store.identities.create('Agent Two');
  store.identities.link(owner.secret, 'wake-room', { identityId: two.identityId, memberId: 'agent-two', displayName: 'Agent Two', permissions: [] });
  // wakeIfOffline only enqueues for agents with at least one registered host.
  store.agentHeartbeats.heartbeat({ agentId: one.identityId, hostId: 'laptop', cadenceSeconds: 60 });
  store.agentHeartbeats.heartbeat({ agentId: two.identityId, hostId: 'laptop', cadenceSeconds: 60 });
  return { store, owner, one, two };
}

function post(store, secret, messageId, body) {
  return store.command(secret, 'wake-room', { id: `cmd-${messageId}`, type: 'message.posted', data: { messageId, body } });
}

function react(store, secret, rid, messageId, active = true) {
  return store.command(secret, 'wake-room', { id: rid, type: 'message.reaction_set', data: { messageId, reaction: '👍', active } });
}

function pending(store, agent) {
  return store.agentHeartbeats.pendingWakes(agent.identityId);
}

test('a reaction acks the reacting member\'s own pending wake signal for that message', t => {
  const { store, owner, one } = fixture();
  t.after(() => store.close());
  post(store, owner.secret, 'm1', 'ping @agent-one');
  const before = pending(store, one);
  assert.equal(before.length, 1);
  assert.equal(before[0].messageId, 'm1');
  // This is the phantom loop: without the fix the same signal would still be
  // pending after the reaction, re-delivered on the next heartbeat poll.
  react(store, one.secret, 'r1', 'm1');
  assert.deepEqual(pending(store, one), []);
  // Idempotent: reacting again is a silent no-op, not an error.
  react(store, one.secret, 'r2', 'm1');
  assert.deepEqual(pending(store, one), []);
});

test('a reaction only acks the reactor\'s own signals: other messages and other members stay pending', t => {
  const { store, owner, one, two } = fixture();
  t.after(() => store.close());
  post(store, owner.secret, 'm1', 'ping @agent-one and @agent-two');
  post(store, owner.secret, 'm2', 'ping @agent-one');
  assert.deepEqual(pending(store, one).map(s => s.messageId).sort(), ['m1', 'm2']);
  assert.deepEqual(pending(store, two).map(s => s.messageId), ['m1']);
  // agent-one reacts to m1: only agent-one's m1 signal is acked.
  react(store, one.secret, 'r1', 'm1');
  assert.deepEqual(pending(store, one).map(s => s.messageId), ['m2']);
  assert.deepEqual(pending(store, two).map(s => s.messageId), ['m1']);
  // The room owner's own reaction acks nothing (owner has no wake signals).
  react(store, owner.secret, 'r3', 'm2');
  assert.deepEqual(pending(store, one).map(s => s.messageId), ['m2']);
});

test('reacting to a message with no pending signals is a silent no-op', t => {
  const { store, owner, one } = fixture();
  t.after(() => store.close());
  post(store, owner.secret, 'm1', 'no mentions here');
  react(store, one.secret, 'r1', 'm1');
  assert.deepEqual(pending(store, one), []);
});
