// A cold room_needs_me (no cursor) starts near the room head, not seq 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test('cold needs-me skips mentions older than the fresh window; since 0 replays them', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  rooms.create(owner.secret, { roomId: 'fresh-room', title: 'fresh', purpose: 'Fresh start', kind: 'personal' });
  linkWithProof(store, owner.secret, 'fresh-room', ada, { displayName: 'Ada', permissions: [] });
  const post = (id, body) => store.command(owner.secret, 'fresh-room', { id, type: 'message.posted', data: { messageId: id, body } });
  post('old-mention', '@Ada old ask');
  for (let i = 0; i < 15; i++) post(`filler-${i}`, 'filler');
  post('new-mention', '@Ada new ask');
  const ids = page => page.items.filter(item => item.kind === 'mention').map(item => item.id);
  const cold = collectNeedsMe(store, ada.secret, { roomId: 'fresh-room', freshWindow: 5 });
  assert.deepEqual(ids(cold), ['new-mention']);
  const replay = collectNeedsMe(store, ada.secret, { roomId: 'fresh-room', since: 0, freshWindow: 5 });
  assert.ok(ids(replay).includes('old-mention'), 'since 0 still replays from the start');
});
