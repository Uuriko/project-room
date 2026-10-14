// r211 (John's Tab QA): a mention edited or deleted after posting. #2941 made
// needs-me room DMs follow the live projection (deleted DMs absent, edited DMs
// show the current body). Mentions come from store.openDirectMentions, which
// still reads the body logged at post time, so room_needs_me and the agent
// inbox list a deleted mention (blank summary, a room_reply next step aimed at
// a tombstone) and keep the pre-edit text of an edited one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';

function seeded(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('OwnerMx');
  const ada = store.identities.create('Ada');
  const roomId = 'mention-current-state';
  rooms.create(owner.secret, { roomId, title: 'mx', purpose: 'x', kind: 'personal' });
  store.identities.link(owner.secret, roomId, { identityId: ada.identityId, displayName: 'Ada', permissions: [] });
  const post = (id, body) => store.command(owner.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body } });
  post('m-live', '@Ada live mention');
  post('m-edited', '@Ada PRE-EDIT deploy to prod');
  post('m-deleted', '@Ada DELETED pasted token');
  store.command(owner.secret, roomId, { id: 'edit-1', type: 'message.edited', data: { messageId: 'm-edited', expectedMessageRevision: 0, body: '@Ada do NOT deploy' } });
  store.command(owner.secret, roomId, { id: 'delete-1', type: 'message.deleted', data: { messageId: 'm-deleted', expectedMessageRevision: 0 } });
  return { store, ada, roomId };
}

test('needs-me mentions honour deletions and edits', t => {
  const { store, ada } = seeded(t);
  const mentions = collectNeedsMe(store, ada.secret, {}).items.filter(i => i.kind === 'mention');
  assert.deepEqual(mentions.map(i => i.id).sort(), ['m-edited', 'm-live'], 'deleted mention must not surface as an attention item');
  assert.equal(mentions.find(i => i.id === 'm-edited').summary, '@Ada do NOT deploy', 'edited mention must show its current body, not the pre-edit text');
  assert.equal(mentions.find(i => i.id === 'm-live').summary, '@Ada live mention');
});

test('openDirectMentions (agent inbox source) honours deletions and edits', t => {
  const { store, ada, roomId } = seeded(t);
  const memberId = store.authenticate(ada.secret, roomId).member.id;
  const rows = store.openDirectMentions(roomId, memberId, 50);
  assert.deepEqual(rows.map(r => r.messageId).sort(), ['m-edited', 'm-live']);
  assert.equal(rows.find(r => r.messageId === 'm-edited').body, '@Ada do NOT deploy');
});
