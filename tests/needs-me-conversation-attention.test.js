import {seedHistoricalNeedsMeRoom} from './helpers/historical-needs-me-room.mjs';
// RES-1538 (reply-alert): needs-me misses conversation attention.
//
// (a) A reply to one's own post carrying no @mention and no formal reply
// request had no selection of its own in server/needs-me.mjs. It surfaced
// only through a store write-time side effect (the mention_states reply row
// in trackMentions), which fires solely when the parent author is an
// agent-kind member AND the parent is resident in the live projection at
// reply time. A human-kind seat (below) got no row and no item: the reply
// was invisible. Fixed by a first-class "reply" kind selected from the
// event log, the way roomDmsOf selects DMs.
//
// (b) The mention scan window (mentionHorizon) counted raw mention_states
// rows, including rows openDirectMentions itself discards: deleted/redacted
// messages, and timed_out rows the member already answered or
// late-acknowledged. With a provided cursor, dead rows consumed the whole
// 100-row window: the read returned a window ending before live mentions
// newer than the cursor, the returned cursor sat ahead of the returned
// items, and hasMore was true. Live shape (Jill's seat, muse-room,
// 2026-10-31): window seq 15210-16196, cursor 16269, hasMore=true, newer
// mentions unreturned. Fixed by counting only selection-eligible rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe, roomAttention } from '../server/needs-me.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

for(const current of [false,true]) {
function setup(t, roomId) {
  const store = new RoomStore(':memory:');
  let clock = Date.now();
  store.now = () => (clock += 2100); // stay under the chat flood guard
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  const owner = store.identities.create('OwnerC');
  if(current)rooms.create(owner.secret,{roomId,title:roomId,purpose:'Conversation attention',kind:'personal'});else seedHistoricalNeedsMeRoom(store,owner,{roomId,title:roomId,purpose:'Conversation attention',kind:'personal'});
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  linkWithProof(store, owner.secret, roomId, bob, { displayName: 'Bob', permissions: [] });
  setTier(store.db, roomId, bob.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  return { store, ada, bob, owner, roomId, advanceClock: ms => { clock += ms; } };
}

test(`needs-me selects a reply to my post with no mention and no formal request as its own kind current=${current}`, t => {
  const { store, ada, bob, owner, roomId } = setup(t, 'conv-reply');
  // A human-kind seat: trackMentions writes no reply row for this member, so
  // at the pre-fix head nothing selected the reply at all.
  store.command(owner.secret, roomId, { id: 'add-maya', type: 'member.added', data: { memberId: 'maya', displayName: 'Maya', kind: 'human', permissions: [] } });
  const maya = store.identities.create('Maya');
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run(roomId, maya.identityId, 'maya', Date.now());
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  post(maya.secret, 'maya-post', { body: 'Maya original post' });
  post(bob.secret, 'bob-reply', { body: 'Bob replying in thread, no mention', replyToId: 'maya-post' });
  // Controls that must NOT become reply items for Maya:
  post(bob.secret, 'bob-ask-reply', { body: 'formal ask threaded on the post', replyToId: 'maya-post', toMemberId: 'maya', requestKind: 'reply' });
  post(maya.secret, 'maya-self-reply', { body: 'Maya following up herself', replyToId: 'maya-post' });
  post(bob.secret, 'bob-post', { body: 'Bob original post' });
  post(owner.secret, 'owner-reply-to-bob', { body: 'Owner replying to Bob', replyToId: 'bob-post' });

  const page = attention(store,maya.secret);
  const replies = page.items.filter(item => item.kind === 'reply');
  assert.deepEqual(replies.map(item => item.id), ['bob-reply'], 'the plain thread reply is selected as kind "reply"');
  assert.equal(replies[0].roomId, roomId);
  assert.equal(replies[0].replyToId, 'maya-post', 'the reply item names its parent post');
  assert.equal(replies[0].summary, 'Bob replying in thread, no mention');
  assert.equal(replies[0].next.tool, 'room_reply');
  assert.equal(replies[0].next.arguments.replyToId, 'bob-reply');
  // The formal ask still surfaces through its own kinds, never as a reply.
  assert.ok(page.items.some(item => item.id === 'bob-ask-reply' && item.kind !== 'reply'), 'formal reply request keeps its own kind');
  assert.ok(!page.items.some(item => item.id === 'maya-self-reply'), 'own replies are not attention');
  assert.ok(!page.items.some(item => item.id === 'owner-reply-to-bob'), 'replies to another member\'s post are not mine');
  // The room digest shares the same selection.
  const roomItems = current?attention(store,maya.secret).items:roomAttention(store, roomId, 'maya', maya.identityId, 0);
  assert.ok(roomItems.some(item => item.kind === 'reply' && item.id === 'bob-reply'), 'roomAttention carries the reply kind');

  // Agent-kind control: the reply row side effect already surfaces Bob's
  // reply to Ada as a mention; the reply kind must not double-list it.
  post(ada.secret, 'ada-post', { body: 'Ada original post' });
  post(bob.secret, 'bob-reply-ada', { body: 'Bob replying to Ada, no mention', replyToId: 'ada-post' });
  const adaPage = attention(store,ada.secret);
  const adaHits = adaPage.items.filter(item => item.id === 'bob-reply-ada');
  assert.equal(adaHits.length, 1, 'a reply already surfaced as an open mention is listed once');
  assert.equal(adaHits[0].kind, 'mention');
});

test(`needs-me mention window is not consumed by mentions the selection discards current=${current}`, t => {
  const { store, ada, bob, roomId, advanceClock } = setup(t, 'conv-window');
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  // The historical producer omits two onboarding events. Keep this exact
  // boundary specimen above the original 256-event scan clamp in both arms.
  if(!current)for(let i=0;i<2;i++)post(bob.secret,`boundary-noise-${i}`,{body:'Unrelated boundary event'});
  // 50 dead rows of the timed_out-and-answered class: minimum timeout, let
  // them expire, then Ada answers each in thread (her first answer's
  // trackMentions flips them to timed_out; the terminal state stays).
  // mentionHorizon counted these rows; openDirectMentions discards them
  // (timed_out + hasReply).
  store.db.prepare("INSERT INTO room_mention_settings(room_id, timeout_ms, updated_at) VALUES(?,?,?)")
    .run(roomId, 60_000, Date.now());
  for (let i = 0; i < 50; i++) post(bob.secret, `stale-t-${i}`, { body: `@Ada stale timed mention ${i}` });
  advanceClock(180_000);
  for (let i = 0; i < 50; i++) post(ada.secret, `ada-answer-${i}`, { body: 'answered in thread', replyToId: `stale-t-${i}` });
  // 50 dead rows of the deleted class: mentioned, then deleted.
  for (let i = 0; i < 50; i++) {
    post(bob.secret, `stale-d-${i}`, { body: `@Ada stale deleted mention ${i}` });
    store.command(bob.secret, roomId, { id: `del-d-${i}`, type: 'message.deleted', data: { messageId: `stale-d-${i}`, expectedMessageRevision: 0 } });
  }
  post(bob.secret, 'fresh-mention', { body: '@Ada fresh mention that matters' });
  const head = store.roomAuthority(roomId).sequence;
  const freshSeq = store.db.prepare("SELECT sequence FROM events WHERE room_id=? AND json_extract(body,'$.data.messageId')='fresh-mention'").get(roomId).sequence;

  // A read carrying a provided cursor (the caller's saved position at the
  // room's start) must not return a window that misses the live mention
  // newer than that cursor. At the pre-fix head this returned items=[] with
  // cursor=304 (ahead of the returned window) and hasMore=true.
  // Round 2 (scan stepping, Codex seq 25273): this room holds more events
  // (257) than the reply scan's examined-row budget (256), so the first
  // read now stops at examined ground — cursor at the last examined
  // sequence, hasMore=true — and the continuation delivers the mention.
  // What defect (b) pins is unchanged: the 100 dead mention rows never
  // consume the mention window (the mention scan counts only eligible
  // rows, so two pages suffice — the dead rows force no extra paging),
  // the cursor never claims unscanned ground, and the chain completes.
  const pages = [];
  let since = { rooms: { [roomId]: 0 }, land: {}, landIds: {} };
  for (let i = 0; i < (current?100:10); i++) {
    const page = collectNeedsMe(store, ada.secret, { since });
    pages.push(page);
    since = JSON.parse(JSON.stringify(page.cursor));
    if (!page.hasMore) break;
  }
  const delivered = pages.flatMap(p => p.items).filter(item => item.kind === 'mention' && item.id === 'fresh-mention');
  assert.equal(delivered.length, 1,
    `fresh mention (seq ${freshSeq} of head ${head}) is delivered exactly once by the chain; pages=${pages.map(p => JSON.stringify(p.items.map(i => i.id)))}`);
  assert.equal(current?pages.at(-1).hasMore:pages.length,current?false:2,
    'one budget page plus the delivery page: the dead mention rows forced no extra paging');
  assert.equal(pages[0].hasMore, true, 'the first read admits its scan stopped at the examined-row budget');
  assert.equal(pages.at(-1).hasMore, false, 'the chain reached the head truthfully instead of paging through dead rows');
});

test(`needs-me cursor chain still enumerates a live mention backlog completely current=${current}`, t => {
  const { store, ada, bob, roomId } = setup(t, 'conv-chain');
  const post = (secret, id, data) => store.command(secret, roomId, { id, type: 'message.posted', data: { messageId: id, ...data } });
  const expected = [];
  for (let i = 0; i < 25; i++) {
    post(bob.secret, `live-${i}`, { body: `@Ada live mention ${i}` });
    expected.push(`live-${i}`);
  }
  const seen = [];
  let since;
  let page;
  for (let count = 0; count < 20; count++) {
    page = collectNeedsMe(store, ada.secret, { since });
    for (const item of page.items) if (item.kind === 'mention') seen.push(item.id);
    since = JSON.parse(JSON.stringify(page.cursor));
    if (!page.hasMore) break;
  }
  assert.equal(page.hasMore, false, 'continuation finishes');
  assert.deepEqual(seen.sort(), expected.sort(), 'every live mention is enumerated exactly once across the chain');
});

}
function attention(store,secret){const items=[];let since;for(let n=0;n<100;n++){const page=collectNeedsMe(store,secret,{since});items.push(...page.items);if(!page.hasMore)return{...page,items};since=page.cursor;}assert.fail('attention did not complete');}
