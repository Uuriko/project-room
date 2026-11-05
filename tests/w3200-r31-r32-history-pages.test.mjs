// W3200 R-31 / R-32 — history page contract on current-format rooms.
//
// R-31: readConversation validates limit 1..100 as legal, but the current
// repository refused limit > 64 with 409 current_room_context_unavailable,
// so the documented page sizes 65..100 could never be served in
// current-format rooms (legacy rooms honoured them).
// R-32: a nominal limit=50/64 page delivered ~15 messages: the merge loop
// stopped when the shared 200-record read budget tripped mid-page and
// returned a partial page, so clients needed ~4x the pages to walk history.
//
// Fixture: a current-format room with 1,000 plain public messages posted by
// individual commands (one transition + witness receipt per message — the
// production shape), read through the public readConversation path.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNeedsMeRoom} from './helpers/canonical-needs-me-room.mjs';
import {readConversation} from '../server/conversation-sync.mjs';

const TOTAL = 1000;
let fixture = null;
function room() {
  if (fixture) return fixture;
  const f = canonicalNeedsMeRoom({after: () => {}});
  for (let i = 0; i < TOTAL; i++) {
    f.send(f.owner, 'message.posted', {messageId: 'm' + String(i).padStart(4, '0'), body: 'plain message ' + i});
  }
  fixture = f;
  return f;
}
after(() => fixture?.store.close());

test('R-31: validated limits 65..100 return a page instead of 409 on a current-format room', () => {
  const f = room();
  for (const limit of [65, 100]) {
    const page = readConversation(f.store, f.owner.secret, f.roomId, {limit});
    assert.equal(page.mode, 'replace');
    assert.ok(page.messages.length > 0, `limit=${limit} returned an empty page`);
    assert.equal(page.messages.at(-1).id, 'm' + String(TOTAL - 1).padStart(4, '0'));
    // A short page is honest only when it carries a continuation.
    if (page.messages.length < limit) {
      assert.equal(page.sourceWindow.complete, false);
      assert.notEqual(page.nextCursor, null);
    }
  }
});

test('R-32: a limit=50 page delivers 50 messages on a 1,000-message current-format room', () => {
  const f = room();
  const page = readConversation(f.store, f.owner.secret, f.roomId, {limit: 50});
  assert.equal(page.messages.length, 50);
  assert.equal(page.sourceWindow.examined, 50);
  assert.equal(page.sourceWindow.complete, false); // 950 messages remain below the window
  assert.notEqual(page.nextCursor, null);
  assert.equal(page.messages[0].id, 'm' + String(TOTAL - 50).padStart(4, '0'));
  assert.equal(page.messages.at(-1).id, 'm' + String(TOTAL - 1).padStart(4, '0'));

  const page2 = readConversation(f.store, f.owner.secret, f.roomId, {limit: 50, cursor: page.nextCursor});
  assert.equal(page2.messages.length, 50);
  assert.equal(page2.messages.at(-1).id, 'm' + String(TOTAL - 51).padStart(4, '0'));
  const seen = new Set([...page.messages, ...page2.messages].map(m => m.id));
  assert.equal(seen.size, 100);
});

test('R-32: a limit=64 page delivers 64 messages', () => {
  const f = room();
  const page = readConversation(f.store, f.owner.secret, f.roomId, {limit: 64});
  assert.equal(page.messages.length, 64);
  assert.equal(page.sourceWindow.examined, 64);
});
