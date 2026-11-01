// Round 2 of W2-F9-CURE (RES-1538, Codex's exact-SQL falsifier, room
// seq 25273): at the round-1 cured head the reply and mention scans
// reported examined rows their SQL RETURNED, while the queries filtered
// inside SQLite — a json_extract predicate under a LIMIT for replies,
// and a join the planner drove from the events range for mentions — so
// the SQLite VM stepped every event in the range. Measured with the
// module's exact SQL against harness fixtures (progress-handler VM
// instruction counts): the reply candidate query cost 9,111
// instructions in a 1,008-event room with ZERO reply rows (Codex:
// 9,059 at 1k growing to 90,059 at 10k, ~9 per plain event); the
// mention horizon query cost 10,216 in a 1,006-event room with 3
// mention rows (Codex: 11,354 -> 110,354, ~11 per event).
//
// The cure steps the events range in JS and counts every stepped row
// and body byte, so the budgets bind in the units the falsifier
// measures. node:sqlite exposes no VM-instruction counter to JS, so
// this file pins the observable contract that bounds the VM work:
// per-scan examined rows/bytes in the read's scan report, in exactly
// the falsifier's shapes. At the round-1 head these tests fail: the
// per-scan report does not exist, and in the plain room the reply scan
// reported 0 examined rows with hasMore=false while the VM walked the
// whole history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe, REPLY_SCAN_ROW_BUDGET, MENTION_SCAN_ROW_BUDGET, DM_SCAN_ROW_BUDGET, REPLY_SCAN_BYTE_BUDGET } from '../server/needs-me.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function setup(t, roomId) {
  const store = new RoomStore(':memory:');
  let clock = Date.now();
  store.now = () => (clock += 2100); // stay under the chat flood guard
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const owner = store.identities.create('OwnerC');
  rooms.create(owner.secret, { roomId, title: roomId, purpose: 'Examined bounds', kind: 'personal' });
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

test('examined bounds: a plain room with zero replies costs the reply budget, not the history size', t => {
  const scannedBySize = [];
  for (const plainCount of [320, 3200]) {
    const roomId = `plain-${plainCount}`;
    const { store, bob, owner, post } = setup(t, roomId);
    const maya = addMaya(store, owner, roomId);
    post(maya.secret, 'maya-post', { body: 'Maya original post' });
    // Plain posts: no replyToId, no mentions — zero candidate rows for
    // either scan, the falsifier's exact shape.
    for (let i = 0; i < plainCount; i++) {
      post(i % 2 ? owner.secret : bob.secret, `plain-${i}`, { body: `plain post ${i}` });
    }
    const page = collectNeedsMe(store, maya.secret, { since: { rooms: { [roomId]: 0 }, land: {}, landIds: {} } });
    assert.equal(page.items.filter(item => item.kind === 'reply').length, 0, 'no replies exist to return');
    scannedBySize.push(page.scan.replies.scannedRows);
    assert.equal(page.scan.replies.scannedRows, REPLY_SCAN_ROW_BUDGET,
      `the reply scan examines exactly its budget at ${plainCount} plain posts (got ${page.scan.replies.scannedRows})`);
    assert.equal(page.scan.replies.exhausted, true, 'the reply scan stopped at its budget before the range end');
    assert.ok(page.scan.mentions.scannedRows <= MENTION_SCAN_ROW_BUDGET,
      `the mention scan stays inside its budget (got ${page.scan.mentions.scannedRows})`);
    // The aggregate sums every attention scan; the DM scan joined it
    // when roomDmsOf was bounded (stacked cure), so the summed bound
    // carries all three budgets.
    assert.ok(page.scan.scannedRows <= REPLY_SCAN_ROW_BUDGET + MENTION_SCAN_ROW_BUDGET + DM_SCAN_ROW_BUDGET,
      `the aggregate examined rows stay inside the summed budgets (got ${page.scan.scannedRows})`);
    assert.equal(page.hasMore, true, 'a budget-exhausted read signals continuation, never completeness');
    if (plainCount === 320) {
      const pages = chainPages(store, maya.secret, roomId);
      assert.equal(pages.at(-1).hasMore, false, 'the chain completes at the head');
      assert.ok(pages.slice(0, -1).every(p => p.hasMore), 'no earlier page claimed completeness');
    }
  }
  assert.deepEqual(scannedBySize, [REPLY_SCAN_ROW_BUDGET, REPLY_SCAN_ROW_BUDGET],
    'reply-scan examined rows stay budget-bound as plain history grows 10x');
});

test('examined bounds: sparse mentions among plain posts are delivered by continuation at bounded per-read cost', t => {
  const roomId = 'sparse-mentions-plain';
  const { store, ada, bob, owner, post } = setup(t, roomId);
  const mentionAt = new Map([[300, 'sparse-m-0'], [900, 'sparse-m-1'], [1500, 'sparse-m-2']]);
  for (let i = 0; i < 1800; i++) {
    if (mentionAt.has(i)) post(bob.secret, mentionAt.get(i), { body: `@Ada sparse mention ${i}` });
    else post(i % 2 ? owner.secret : bob.secret, `plain-${i}`, { body: `plain post ${i}` });
  }
  const pages = chainPages(store, ada.secret, roomId);
  const mentionIds = pages.flatMap(p => p.items).filter(item => item.kind === 'mention').map(item => item.id);
  assert.deepEqual([...mentionIds].sort(), ['sparse-m-0', 'sparse-m-1', 'sparse-m-2'],
    'continuation reaches every sparse mention exactly once');
  assert.equal(new Set(mentionIds).size, mentionIds.length, 'no mention is delivered twice');
  assert.equal(pages[0].scan.mentions.scannedRows, MENTION_SCAN_ROW_BUDGET,
    'the first read examines exactly the mention budget, not the whole range');
  assert.ok(pages.every(p => p.scan.scannedRows <= REPLY_SCAN_ROW_BUDGET + MENTION_SCAN_ROW_BUDGET + DM_SCAN_ROW_BUDGET),
    'every page stays inside the summed examined-row budgets');
  const deliveredAt = pages.findIndex(p => p.items.some(item => item.id === 'sparse-m-2'));
  assert.ok(deliveredAt > 0, 'the sparsest mention needed continuation, not one unbounded read');
  assert.ok(pages.slice(0, deliveredAt).every(p => p.hasMore), 'no page before the sparsest mention claimed completeness');
  assert.equal(pages.at(-1).hasMore, false, 'the chain completes at the head');
});

test('examined bounds: the byte budget stops a scan of very large events before the row budget does', t => {
  const roomId = 'byte-boundary';
  const { store, bob, owner, post } = setup(t, roomId);
  const maya = addMaya(store, owner, roomId);
  post(maya.secret, 'maya-post', { body: 'Maya original post' });
  const bigBody = 'x'.repeat(60_000);
  for (let i = 0; i < 20; i++) post(bob.secret, `big-${i}`, { body: `${bigBody} ${i}` });
  const page = collectNeedsMe(store, maya.secret, { since: { rooms: { [roomId]: 0 }, land: {}, landIds: {} } });
  // Round 3 amendment (Codex seq 25331): this assertion used to pin
  // scannedBytes >= the byte budget — the crossing row was examined
  // and counted, so the total landed OVER the budget. The admission
  // falsifier refuted that semantics (payload crossed before the
  // count bound it), so the scan now stops BEFORE the crossing row:
  // the examined total never crosses the budget, and lands within one
  // big row of it — every row that fits was admitted.
  assert.ok(page.scan.replies.scannedBytes <= REPLY_SCAN_BYTE_BUDGET,
    `admission never transfers past the byte budget (got ${page.scan.replies.scannedBytes})`);
  assert.ok(page.scan.replies.scannedBytes + 60_011 > REPLY_SCAN_BYTE_BUDGET,
    `the reply scan admitted every row that fits — one more ~60KB row could not (got ${page.scan.replies.scannedBytes})`);
  assert.ok(page.scan.replies.scannedRows < REPLY_SCAN_ROW_BUDGET,
    `the byte budget bound before the row budget (examined ${page.scan.replies.scannedRows} rows)`);
  assert.ok(page.scan.replies.scannedRows > 0, 'the scan still made progress — no zero-progress stall on oversized events');
  // Both scans step the same stream from the same cursor under the
  // same byte budget, so the mention scan's byte stop sets the reply
  // scan's range end exactly where its own byte stop lands: the reply
  // scan truthfully examined its whole assigned range, and the READ
  // is the level that reports the byte exhaustion.
  assert.equal(page.scan.mentions.exhausted, true, 'the mention scan stopped at its byte budget before the range end');
  assert.equal(page.scan.exhausted, true, 'the read names a budget as the reason it stopped');
  assert.equal(page.hasMore, true, 'a byte-exhausted read signals continuation, never completeness');
});
