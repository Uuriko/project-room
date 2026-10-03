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
    store.identities.link(owner.secret, roomId, { identityId: ada.identityId, displayName: 'Ada', permissions: [] });
    store.identities.link(owner.secret, roomId, { identityId: bob.identityId, displayName: 'Bob', permissions: [] });
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
test('needs-me room_reply suggestions carry a stable requestId', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const roomId = 'rid-reqid';
  const owner = store.identities.create('OwnerRid');
  rooms.create(owner.secret, { roomId, title: 'rid', purpose: 'x', kind: 'personal' });
  store.identities.link(owner.secret, roomId, { identityId: ada.identityId, displayName: 'Ada', permissions: [] });
  store.identities.link(owner.secret, roomId, { identityId: bob.identityId, displayName: 'Bob', permissions: [] });
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
