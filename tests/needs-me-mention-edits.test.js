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
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function seeded(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('OwnerMx');
  const ada = store.identities.create('Ada');
  const roomId = 'mention-current-state';
  rooms.create(owner.secret, { roomId, title: 'mx', purpose: 'x', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
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

// r213 (John's Tab, 13063): the refill loop paged the wrong way. The query
// orders sequence DESC, so advancing the cursor to the batch's lowest
// sequence re-read the newest rows: once a deleted mention forced a refill,
// the list repeated items and dropped older ones. Agents set this limit
// (1..200) via room_inbox and agent-inbox, so they hit it.
function paged(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('OwnerMx');
  const ada = store.identities.create('Ada');
  const roomId = 'mention-paging';
  rooms.create(owner.secret, { roomId, title: 'mx', purpose: 'x', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  const post = (id, body) => store.command(owner.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body } });
  const del = (id) => store.command(owner.secret, roomId, { id: 'del-' + id, type: 'message.deleted', data: { messageId: id, expectedMessageRevision: 0 } });
  for (const id of ['m10', 'm20', 'm30', 'm40', 'm50']) post(id, `@Ada mention ${id}`);
  return { store, ada, roomId, del };
}

test('openDirectMentions paging stays distinct when a deletion forces a refill', t => {
  const { store, ada, roomId, del } = paged(t);
  const memberId = store.authenticate(ada.secret, roomId).member.id;
  del('m50');
  del('m20');
  const rows = store.openDirectMentions(roomId, memberId, 3);
  assert.deepEqual(rows.map(r => r.messageId), ['m40', 'm30', 'm10'], 'refill must page older rows, not repeat the newest batch');
});

test('openDirectMentions keeps the oldest mention when top deletions force multiple refills', t => {
  const { store, ada, roomId, del } = paged(t);
  const memberId = store.authenticate(ada.secret, roomId).member.id;
  del('m50');
  del('m40');
  const rows = store.openDirectMentions(roomId, memberId, 3);
  assert.deepEqual(rows.map(r => r.messageId), ['m30', 'm20', 'm10']);
});
