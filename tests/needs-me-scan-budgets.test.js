import {seedHistoricalNeedsMeRoom} from './helpers/historical-needs-me-room.mjs';
// W2-F9-CURE (RES-1538, Codex source review seq 25038): the reply and
// mention-horizon scans in server/needs-me.mjs must be bounded, and a
// budget-exhausted read must say so instead of looking complete.
//
// The pre-cure head (8563546e) built a Set of every message id the
// reader ever authored and batch-looped reply events with no sequence
// bound and no budget: a no-match room scanned its whole reply history
// per read, and mentionHorizon pre-built two more full-history id sets.
// These tests pin the cured contract:
//   (a) LARGE NO-MATCH ROOM — scanned rows are bounded by the stated
//       budget (256 reply rows / 512 mention rows per room per read),
//       not by history size: the same read at 320 and at 3,200 noise
//       replies examines exactly the reply budget both times, reports
//       scan.exhausted, and keeps hasMore=true (honest continuation).
//       Round 2 (Codex seq 25273) amended the accounting, not the
//       contract: the report now carries per-scan components
//       (scan.replies / scan.mentions), and the mention component
//       counts the events its scan steps over — the pre-round-2
//       aggregate asserted 256 in total because the mention scan
//       reported 0 examined rows while its SQL walked the whole
//       range. The reply component still asserts exactly 256 at both
//       history sizes; the aggregate is bounded by 256 + 512.
//   (b) SPARSE-MATCH ROOM — matches spread across a large history are
//       all reached by cursor continuation, exactly once each, and no
//       page claims completeness (hasMore=false) before the page that
//       delivers the last unscanned match.
// Against the pre-cure head both tests fail: there is no scan report,
// no budget, and the no-match read returns hasMore=false after
// examining the entire history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const REPLY_ROW_BUDGET = 256; // REPLY_SCAN_ROW_BUDGET in server/needs-me.mjs
const MENTION_ROW_BUDGET = 512; // MENTION_SCAN_ROW_BUDGET in server/needs-me.mjs

function setup(t, roomId) {
  const store = new RoomStore(':memory:');
  let clock = Date.now();
  store.now = () => (clock += 2100); // stay under the chat flood guard
  t.after(() => store.close());
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const owner = store.identities.create('OwnerC');
  seedHistoricalNeedsMeRoom(store,owner, { roomId, title: roomId, purpose: 'Scan budgets', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  return { store, ada, bob, owner, roomId, post };
}

function addMaya(store, owner, roomId) {
  store.command(owner.secret, roomId, { id: 'add-maya', type: 'member.added', data: { memberId: 'maya', displayName: 'Maya', kind: 'human', permissions: [] } });
  const maya = store.identities.create('Maya');
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run(roomId, maya.identityId, 'maya', Date.now());
  return maya;
}

function chainPages(store, secret, roomId, maxPages = 40) {
  const pages = [];
  let since = { rooms: { [roomId]: 0 }, land: {}, landIds: {} };
  for (let i = 0; i < maxPages; i++) {
    const page = collectNeedsMe(store, secret, { since });
    pages.push(page);
    since = JSON.parse(JSON.stringify(page.cursor));
    if (!page.hasMore) break;
  }
  return pages;
}

test('scan budget: a large no-match room costs the budget, not the history size', t => {
  const scannedBySize = [];
  for (const replyCount of [320, 3200]) {
    const roomId = `nomatch-${replyCount}`;
    const { store, bob, owner, post } = setup(t, roomId);
    const maya = addMaya(store, owner, roomId);
    post(maya.secret, 'maya-post', { body: 'Maya original post' });
    post(bob.secret, 'bob-post', { body: 'Bob original post' });
    // A large reply history with zero replies to Maya's post.
    for (let i = 0; i < replyCount; i++) {
      post(i % 2 ? owner.secret : bob.secret, `noise-${i}`, { body: `noise reply ${i}`, replyToId: 'bob-post' });
    }
    const page = collectNeedsMe(store, maya.secret, { since: { rooms: { [roomId]: 0 }, land: {}, landIds: {} } });
    assert.equal(page.items.filter(item => item.kind === 'reply').length, 0, 'no matches exist to return');
    assert.ok(page.scan, 'the read reports its scan cost');
    assert.equal(page.scan.rowBudgets.replies, REPLY_ROW_BUDGET, 'the stated reply budget rides the result');
    scannedBySize.push(page.scan.replies.scannedRows);
    assert.equal(page.scan.replies.scannedRows, REPLY_ROW_BUDGET,
      `the reply scan examines exactly its budget, not the ${replyCount}-row history (got ${page.scan.replies.scannedRows})`);
    assert.ok(page.scan.mentions.scannedRows <= MENTION_ROW_BUDGET,
      `the mention scan stays inside its budget (got ${page.scan.mentions.scannedRows})`);
    assert.ok(page.scan.scannedRows <= REPLY_ROW_BUDGET + MENTION_ROW_BUDGET,
      `the aggregate examined rows stay inside the summed budgets (got ${page.scan.scannedRows})`);
    assert.equal(page.scan.exhausted, true, 'the budget stopped the scan before the range end');
    assert.equal(page.hasMore, true, 'a budget-exhausted read signals continuation, never completeness');
    if (replyCount === 320) {
      // Continuation terminates honestly: paging reaches the head, finds
      // nothing, and only then reports completeness.
      const pages = chainPages(store, maya.secret, roomId);
      assert.equal(pages.at(-1).hasMore, false, 'the chain completes at the head');
      assert.equal(pages.at(-1).scan.exhausted, false, 'the final page scanned its whole range');
      assert.ok(pages.slice(0, -1).every(p => p.hasMore), 'no earlier page claimed completeness');
      assert.equal(pages.flatMap(p => p.items).filter(item => item.kind === 'reply').length, 0);
    }
  }
  assert.deepEqual(scannedBySize, [REPLY_ROW_BUDGET, REPLY_ROW_BUDGET],
    'reply-scan examined rows stay budget-bound as history grows 10x');
});

test('scan budget: sparse matches are reached by continuation without skipping or false completeness', t => {
  // Sparse replies: three replies to Maya's post spread across ~900
  // replies to someone else's post (the reply budget is 256 per read).
  {
    const roomId = 'sparse-replies';
    const { store, bob, owner, post } = setup(t, roomId);
    const maya = addMaya(store, owner, roomId);
    post(maya.secret, 'maya-post', { body: 'Maya original post' });
    post(bob.secret, 'bob-post', { body: 'Bob original post' });
    const sparseAt = new Map([[200, 'sparse-0'], [500, 'sparse-1'], [800, 'sparse-2']]);
    for (let i = 0; i < 900; i++) {
      post(i % 2 ? owner.secret : bob.secret, `noise-${i}`, { body: `noise reply ${i}`, replyToId: 'bob-post' });
      if (sparseAt.has(i)) post(bob.secret, sparseAt.get(i), { body: `sparse reply ${i}`, replyToId: 'maya-post' });
    }
    const pages = chainPages(store, maya.secret, roomId);
    const replyIds = pages.flatMap(p => p.items).filter(item => item.kind === 'reply').map(item => item.id);
    assert.deepEqual([...replyIds].sort(), ['sparse-0', 'sparse-1', 'sparse-2'],
      'continuation reaches every sparse match exactly once');
    assert.equal(new Set(replyIds).size, replyIds.length, 'no match is delivered twice');
    assert.equal(pages.at(-1).hasMore, false, 'the chain completes');
    const deliveredAt = pages.findIndex(p => p.items.some(item => item.id === 'sparse-2'));
    assert.ok(deliveredAt > 0, 'the sparsest match needed continuation, not one unbounded read');
    assert.ok(pages.slice(0, deliveredAt).every(p => p.hasMore && p.scan.exhausted),
      'every page before the sparsest match admits its scan stopped at the budget');
  }
  // Sparse mention behind a dead-row run longer than the horizon budget
  // (512): the first read must not return a window missing the live
  // mention while claiming completeness.
  {
    const roomId = 'sparse-mentions';
    const { store, ada, bob, post } = setup(t, roomId);
    for (let i = 0; i < 600; i++) {
      post(bob.secret, `dead-${i}`, { body: `@Ada dead mention ${i}` });
      store.command(bob.secret, roomId, { id: `del-${i}`, type: 'message.deleted', data: { messageId: `dead-${i}`, expectedMessageRevision: 0 } });
    }
    post(bob.secret, 'live-mention', { body: '@Ada live mention that matters' });
    const pages = chainPages(store, ada.secret, roomId);
    const first = pages[0];
    assert.ok(!first.items.some(item => item.id === 'live-mention'), 'the live mention is beyond the first budget');
    assert.equal(first.hasMore, true, 'the first read never claims completeness over unscanned rows');
    assert.equal(first.scan.exhausted, true, 'the first read names the budget as the reason');
    const deliveredAt = pages.findIndex(p => p.items.some(item => item.kind === 'mention' && item.id === 'live-mention'));
    assert.ok(deliveredAt > 0, 'continuation delivers the live mention on a later page');
    assert.ok(pages.slice(0, deliveredAt).every(p => p.hasMore), 'no page before delivery claimed completeness');
    assert.equal(pages.at(-1).hasMore, false, 'the chain completes at the head');
  }
});
