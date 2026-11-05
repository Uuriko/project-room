// Regression: room_list_work (lobby Board) returned 409
// current_room_context_unavailable on big rooms. Each listing page read the
// full member census (record + witness receipt per member) and burned the
// shared 200-record/256KiB current read budget; it failed from ~9 members.
// The list now reads only owner + viewer authority, so cost is O(page).
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNeedsMeRoom} from './helpers/canonical-needs-me-room.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {listRoomWork} from '../server/mcp-room-profile.mjs';

test('Board list pages through every item in a 95-member room without a 409', t => {
  const f = canonicalNeedsMeRoom(t), {store, owner, worker, roomId} = f;
  for (let n = 0; n < 95; n++) {
    const id = store.identities.create('Member ' + n);
    linkWithProof(store, owner.secret, roomId, id, {displayName: ('Member ' + n + ' ').padEnd(80, 'x'), permissions: ['accept_work']});
  }
  for (let i = 0; i < 10; i++) f.propose('w' + String(i).padStart(2, '0'));
  for (const focus of ['all', 'results', 'needs_me']) {
    const seen = []; let cursor, pages = 0;
    do {
      const page = store.currentWorkListing(worker.secret, roomId, {focus, limit: 25, ...(cursor ? {cursor} : {})});
      assert.ok(page, 'current room serves the bounded listing');
      seen.push(...page.work.map(w => w.id)); cursor = page.page.nextCursor; assert.ok(++pages < 50);
    } while (cursor);
    if (focus !== 'results') assert.deepEqual(seen.sort(), Array.from({length: 10}, (_, i) => 'w' + String(i).padStart(2, '0')), focus);
  }
  const mcp = listRoomWork(store, worker.secret, {roomId, limit: 25});
  assert.ok(Array.isArray(mcp.work) && mcp.work.length > 0);
  assert.equal(mcp.member.id, worker.identityId);
});
