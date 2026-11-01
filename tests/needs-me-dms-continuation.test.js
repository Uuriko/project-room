// Bounded DM scan, real-store continuation (stacked on RES-1538
// round 3): a DM sitting past the DM scan's examined-row budget in a
// plain-post room must not be silently passed over by collectNeedsMe —
// the read reports scan.dms.exhausted with the summed budgets, keeps
// hasMore=true, and cursor continuation delivers the DM exactly once.
// Pre-cure, roomDmsOf walked the whole range in one read (unbounded);
// a naive bound without the report would have lost the DM silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe, DM_SCAN_ROW_BUDGET } from '../server/needs-me.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test('dm continuation: a DM past the budget is delivered by paging, never skipped or duplicated', t => {
  const store = new RoomStore(':memory:');
  let clock = Date.now();
  store.now = () => (clock += 2100);
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const bob = store.identities.create('Bob');
  const owner = store.identities.create('OwnerC');
  const roomId = 'dm-continuation';
  rooms.create(owner.secret, { roomId, title: roomId, purpose: 'DM continuation', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  store.command(owner.secret, roomId, { id: 'add-maya', type: 'member.added', data: { memberId: 'maya', displayName: 'Maya', kind: 'human', permissions: [] } });
  const maya = store.identities.create('Maya');
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run(roomId, maya.identityId, 'maya', Date.now());
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  for (let i = 0; i < 300; i++) post(i % 2 ? owner.secret : bob.secret, `plain-${i}`, { body: `plain post ${i}` });
  post(bob.secret, 'the-dm', { body: 'a dm for Maya', toMemberId: 'maya' });

  const pages = [];
  let since = { rooms: { [roomId]: 0 }, land: {}, landIds: {} };
  for (let i = 0; i < 40; i++) {
    const page = collectNeedsMe(store, maya.secret, { since });
    pages.push(page);
    since = JSON.parse(JSON.stringify(page.cursor));
    if (!page.hasMore) break;
  }
  const first = pages[0];
  assert.equal(first.scan.dms.scannedRows, DM_SCAN_ROW_BUDGET,
    'the first read examines exactly the DM budget, not the whole range');
  assert.equal(first.scan.exhausted, true, 'the aggregate scan reports the budget stop');
  // The DM scan's own range was already the reply-clamped window
  // (through = 256) and it covered all of it, so its component
  // honestly reports exhausted=false: per-scan components say which
  // scan stopped, the aggregate says the read stopped.
  assert.equal(first.scan.dms.exhausted, false, 'the DM scan covered its assigned window in full');
  assert.equal(first.scan.rowBudgets.dms, DM_SCAN_ROW_BUDGET, 'the DM budget rides the scan report');
  assert.ok(!first.items.some(item => item.id === 'the-dm'), 'the DM is beyond the first read');
  assert.equal(first.hasMore, true, 'the first read signals continuation');
  const dmDeliveries = pages.flatMap(p => p.items).filter(item => item.kind === 'dm' && item.id === 'the-dm');
  assert.equal(dmDeliveries.length, 1, 'continuation delivers the DM exactly once');
  assert.equal(pages.at(-1).hasMore, false, 'the chain completes at the head');
});
