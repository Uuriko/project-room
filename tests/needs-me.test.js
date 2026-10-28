// Regression contract: following returned cursors must enumerate every eligible
// item across all three caps and timestamp ties, using real persisted state.
// Existing MCP coverage has one item per kind; it cannot detect these losses.
// No test-only production seam is needed: collectNeedsMe serves HTTP and MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test('needs-me continuation preserves overflow DMs, mentions, rooms and tied land changes', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const expected = new Set();
  for (let r = 0; r < 41; r++) {
    const roomId = `pagination-${String(r).padStart(2, '0')}`;
    const owner = store.identities.create(`Owen ${r}`);
    rooms.create(owner.secret, { roomId, title: roomId, purpose: 'Pagination', kind: 'personal' });
    linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
    linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
    setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
    for (let i = 0; i < (r === 0 ? 9 : 3); i++) {
      const id = `dm-${r}-${i}`;
      store.command(bob.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body: 'Ordinary private message', toMemberId: ada.identityId } });
      expected.add(`${roomId}/dm/${id}`);
    }
    if (r === 0) {
      for (let i = 0; i < 9; i++) {
        const id = `mention-${i}`;
        store.command(bob.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body: '@Ada please inspect this' } });
        expected.add(`${roomId}/mention/${id}`);
        const landId = `land-${i}`;
        store.db.prepare(`INSERT INTO land_queue(room_id,item_id,repo,pr_number,claimant_member_id,added_by_member_id,title,mergeable,behind,checks_state,observed,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'unknown',0,'pending',1,100,101)`).run(roomId, landId, 'example/repo', i + 1, ada.identityId, ada.identityId, landId);
        expected.add(`${roomId}/land_queue/${landId}`);
        const requestId = `request-${i}`;
        store.command(bob.secret, roomId, { id: requestId, type: 'message.posted', data: {
          messageId: requestId, body: 'Please respond', toMemberId: ada.identityId, requestKind: 'reply'
        } });
        expected.add(`${roomId}/dm/${requestId}`);
        expected.add(`${roomId}/direct_ask/${requestId}`);
      }
    }
  }
  const seen = new Set();
  let since;
  let page;
  for (let count = 0; count < 80; count++) {
    page = collectNeedsMe(store, ada.secret, { since });
    assert.ok(page.items.length <= 100, 'response remains bounded');
    for (const item of page.items) {
      const key = `${item.roomId}/${item.kind}/${item.id}`;
      assert.ok(!seen.has(key), `cursor must not replay ${key}`);
      seen.add(key);
    }
    since = JSON.parse(JSON.stringify(page.cursor));
    if (!page.hasMore) break;
  }
  assert.deepEqual([...seen].sort(), [...expected].sort(), 'every eligible persisted item must be discoverable');
  assert.equal(page.hasMore, false, 'continuation eventually finishes');
  assert.deepEqual(collectNeedsMe(store, ada.secret, { since }).items, [], 'caught-up cursor is quiet');
  // Legacy numeric cursors still suppress old events after crossing the room cap.
  since = 1_000_000_000;
  for (let count = 0; count < 10; count++) {
    page = collectNeedsMe(store, ada.secret, { since });
    assert.ok(page.items.every(item => item.kind === 'land_queue'), 'numeric floor survives continuation');
    since = page.cursor;
    if (!page.hasMore) break;
  }
  assert.equal(page.hasMore, false);
});

// G-H2 follow-on (audit 2026-09-30): room_reply requires requestId, so the
// needs-me suggested call must carry one — otherwise agents following the
// suggestion hit missing_request_id on the documented path. Contract: every
// mention/dm suggestion includes a stable, non-empty requestId that is
// deterministic across calls (retrying the suggestion is idempotent).
// #2941: roomDmsOf read message.posted events straight from the raw log, so
// a DM deleted before the recipient polled still surfaced (inviting a reply
// to a tombstone) and an edited DM showed its pre-edit body. The item must
// follow the live projection: deleted DMs are absent, edited DMs show the
// current body.
test('needs-me room DMs honour deletions and edits', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const roomId = 'dm-current-state';
  const owner = store.identities.create('OwnerDm');
  rooms.create(owner.secret, { roomId, title: 'dm', purpose: 'x', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const post = (id, body) => store.command(bob.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body, toMemberId: ada.identityId } });
  post('dm-live', 'live dm body');
  post('dm-edited', 'original pre-edit body');
  post('dm-deleted', 'deleted dm body');
  store.command(bob.secret, roomId, { id: 'edit-1', type: 'message.edited', data: { messageId: 'dm-edited', expectedMessageRevision: 0, body: 'edited current body' } });
  store.command(bob.secret, roomId, { id: 'delete-1', type: 'message.deleted', data: { messageId: 'dm-deleted', expectedMessageRevision: 0 } });
  const dms = collectNeedsMe(store, ada.secret, {}).items.filter(i => i.kind === 'dm' && i.channel === 'room');
  assert.deepEqual(dms.map(i => i.id).sort(), ['dm-edited', 'dm-live'], 'deleted DM must not surface as an attention item');
  assert.equal(dms.find(i => i.id === 'dm-edited').summary, 'edited current body', 'edited DM must show its current body, not the pre-edit text');
  assert.equal(dms.find(i => i.id === 'dm-live').summary, 'live dm body');
});

test('needs-me room_reply suggestions carry a stable requestId', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const roomId = 'rid-reqid';
  const owner = store.identities.create('OwnerRid');
  rooms.create(owner.secret, { roomId, title: 'rid', purpose: 'x', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  store.command(bob.secret, roomId, { id: 'm1', type: 'message.posted', data: { messageId: 'm1', body: '@Ada look here' } });
  const first = collectNeedsMe(store, ada.secret, {}).items.find(i => i.kind === 'mention');
  assert.ok(first, 'expected a mention item');
  const rid = first.next?.arguments?.requestId;
  assert.equal(typeof rid, 'string');
  assert.ok(rid.length > 0, 'suggestion must include a requestId');
  const second = collectNeedsMe(store, ada.secret, {}).items.find(i => i.kind === 'mention');
  assert.equal(second.next.arguments.requestId, rid, 'requestId must be stable across calls');
});


// r205 (John's Tab QA): a watermark above a room's head must not be kept.
// A numeric since taken from one room's item seq (or a cursor from before a
// restore) used to pin a quieter room above its head in the returned cursor,
// so that room's next mentions never surfaced while the cursor was followed.
test('needs-me clamps a room watermark that is above the room head', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.roomFlood = { consume() {} };
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  for (const roomId of ['busy', 'quiet']) {
    rooms.create(bob.secret, { roomId, title: roomId, purpose: 'Clamp', kind: 'personal' });
    linkWithProof(store, bob.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  }
  for (let i = 0; i < 30; i++) store.command(bob.secret, 'busy', { id: `c${i}`, type: 'message.posted', data: { messageId: `c${i}`, body: `chatter ${i}` } });
  store.command(bob.secret, 'busy', { id: 'busy-ask', type: 'message.posted', data: { messageId: 'busy-ask', body: '@Ada busy ask' } });
  const first = collectNeedsMe(store, ada.secret, {});
  const seq = first.items.find(item => item.id === 'busy-ask').seq;
  const quietHead = store.roomAuthority('quiet').sequence;
  assert.ok(seq > quietHead + 1, 'the busy room seq is above the quiet room head');
  let page = collectNeedsMe(store, ada.secret, { since: seq });
  assert.ok(page.cursor.rooms.quiet <= quietHead, 'returned cursor stays at or below the quiet room head');
  assert.deepEqual(page.items.filter(item => item.roomId === 'quiet'), [], 'old quiet-room events stay suppressed');
  store.command(bob.secret, 'quiet', { id: 'quiet-ask', type: 'message.posted', data: { messageId: 'quiet-ask', body: '@Ada quiet ask' } });
  page = collectNeedsMe(store, ada.secret, { since: JSON.parse(JSON.stringify(page.cursor)) });
  assert.deepEqual(page.items.map(item => `${item.roomId}/${item.id}`), ['quiet/quiet-ask'], 'the next quiet-room mention surfaces');
  const stale = { rooms: { busy: 10_000, quiet: 10_000 }, land: {}, landIds: {} };
  store.command(bob.secret, 'busy', { id: 'busy-ask-2', type: 'message.posted', data: { messageId: 'busy-ask-2', body: '@Ada after a restore' } });
  page = collectNeedsMe(store, ada.secret, { since: stale });
  assert.ok(page.cursor.rooms.busy <= store.roomAuthority('busy').sequence, 'a cursor from before a restore is clamped');
  store.command(bob.secret, 'busy', { id: 'busy-ask-3', type: 'message.posted', data: { messageId: 'busy-ask-3', body: '@Ada next' } });
  page = collectNeedsMe(store, ada.secret, { since: JSON.parse(JSON.stringify(page.cursor)) });
  assert.deepEqual(page.items.map(item => item.id), ['busy-ask-3'], 'and then resumes delivery');
});


// r216 (John's Tab QA): a numeric since must not follow the agent into rooms it
// joins later. Once a full pass has recorded every linked room, the legacy
// floor used to ride every later cursor, so a room joined afterwards inherited
// it and its first mentions (seq <= that floor) never surfaced.
test('needs-me numeric floor does not hide a room joined after the cursor', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.roomFlood = { consume() {} };
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  rooms.create(bob.secret, { roomId: 'busy', title: 'busy', purpose: 'Floor', kind: 'personal' });
  linkWithProof(store, bob.secret, 'busy', ada, { displayName: 'Ada', permissions: [] });
  for (let i = 0; i < 30; i++) store.command(bob.secret, 'busy', { id: `c${i}`, type: 'message.posted', data: { messageId: `c${i}`, body: `chatter ${i}` } });
  store.command(bob.secret, 'busy', { id: 'busy-ask', type: 'message.posted', data: { messageId: 'busy-ask', body: '@Ada busy ask' } });
  const seq = collectNeedsMe(store, ada.secret, {}).items.find(item => item.id === 'busy-ask').seq;
  let page = collectNeedsMe(store, ada.secret, { since: seq });
  assert.equal(page.hasMore, false);
  rooms.create(bob.secret, { roomId: 'late', title: 'late', purpose: 'Floor', kind: 'personal' });
  linkWithProof(store, bob.secret, 'late', ada, { displayName: 'Ada', permissions: [] });
  store.command(bob.secret, 'late', { id: 'late-ask', type: 'message.posted', data: { messageId: 'late-ask', body: '@Ada welcome, first ask' } });
  assert.ok(store.roomAuthority('late').sequence < seq, 'the new room head is below the old numeric since');
  page = collectNeedsMe(store, ada.secret, { since: JSON.parse(JSON.stringify(page.cursor)) });
  assert.deepEqual(page.items.map(item => `${item.roomId}/${item.id}`), ['late/late-ask'], 'the first mention in a room joined later surfaces');
  page = collectNeedsMe(store, ada.secret, { since: JSON.parse(JSON.stringify(page.cursor)) });
  assert.deepEqual(page.items, [], 'and is not replayed');
});
