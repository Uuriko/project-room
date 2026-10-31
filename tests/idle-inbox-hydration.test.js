import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

test('cold idle inbox does not hydrate unrelated public conversation or work', t => {
  let now = Date.now();
  const store = new RoomStore(':memory:', { now: () => now });
  t.after(() => store.close());
  const owner = store.identities.create('Owen'), ada = store.identities.create('Ada');
  new AgentRooms(store).create(owner.secret, { roomId: 'idle-inbox', title: 'Inbox', purpose: 'Synthetic profile', kind: 'personal' });
  linkWithProof(store, owner.secret, 'idle-inbox', ada, { displayName: 'Ada', permissions: [] });
  for (let i = 0; i < 30; i++) {
    now += 10000;
    store.command(owner.secret, 'idle-inbox', { id: `public-${i}`, type: 'message.posted', data: { body: 'public '.repeat(2000) } });
  }
  const before = store.agentInbox(ada.secret, 'idle-inbox');
  store._dropProjectionCache();
  let hydrations = 0;
  const read = store._readProjection.bind(store);
  store._readProjection = (...args) => { hydrations++;return read(...args); };
  const after = store.agentInbox(ada.secret, 'idle-inbox');
  assert.deepEqual(after, before);
  assert.deepEqual(after.directMessages, []);
  assert.deepEqual(after.directMentions, []);
  assert.equal(hydrations, 0);
  // A subsequent real addressed request still uses the canonical repository.
  now += 10000;
  store.command(owner.secret, 'idle-inbox', { id: 'request', type: 'message.posted', data: { messageId: 'request', body: 'Please reply', toMemberId: ada.identityId, requestKind: 'reply' } });
  store._dropProjectionCache();hydrations = 0;
  const active = store.agentInbox(ada.secret, 'idle-inbox');
  assert.equal(active.directMessages[0].body, 'Please reply');
  assert.ok(active.next.some(row => row.action === 'read-request' && row.required === true));
  assert.ok(hydrations > 0);
});
