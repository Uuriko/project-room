// needs-me / room_read_inbox on a normalized room 409'd with
// current_room_context_unavailable whenever the newest window held several long
// posts: the shared 256 KiB read allowance was spent by the proof read of each
// selected message and again by its event envelope. The recent window now keeps
// what it read, resumes at the next older row, and retries as a single-row
// window when not even one row fit. Every addressed item is still found.
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNeedsMeRoom} from './helpers/canonical-needs-me-room.mjs';
import {collectNeedsMe} from '../server/needs-me.mjs';

for (const [count, size] of [[20, 60000], [30, 40000]]) {
  test(`needs-me pages through ${count} long (${size} B) posts without a 409 and finds every addressed one`, t => {
    const f = canonicalNeedsMeRoom(t), {store, owner, worker, roomId, send} = f;
    const addressed = [];
    for (let i = 0; i < count; i++) {
      const to = i % 3 === 0;
      if (to) addressed.push('m' + i);
      send(owner, 'message.posted', {messageId: 'm' + i, body: 'x'.repeat(size) + ' ' + i, ...(to ? {toMemberId: worker.identityId} : {})});
    }
    let page = collectNeedsMe(store, worker.secret, {roomId}), calls = 1;
    const ids = new Set(page.items.map(item => item.id));
    while (page.hasMore) {
      assert.ok(calls++ < 200, 'the scan terminates');
      page = collectNeedsMe(store, worker.secret, {roomId, since: page.cursor});
      for (const item of page.items) ids.add(item.id);
    }
    assert.equal(page.complete, true);
    for (const id of addressed) assert.ok([...ids].some(item => item.includes(id)), `${id} surfaced`);
  });
}
