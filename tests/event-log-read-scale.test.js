// FIX-4: event-log read scalability.
//
// 1. A routine mention-timeout flip on the read path must not invalidate the
//    room projection cache. The flip touches only mention_states, but it ran
//    through RoomStore#transaction, which drops the whole projection cache
//    after every write commit. The very next read then paid a full synchronous
//    projection rehydration (JSON.parse + hydrate + deepFreeze of a
//    multi-megabyte object), serializing every concurrent reader behind it.
// 2. Paged reads follow the next/hasMore contract exactly: with DM-filtered
//    gaps in the log, a client paging by next/hasMore sees every visible
//    event exactly once, in order, and terminates (the cursor advances by
//    what was scanned, not by what was visible).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { mentionStateSchema } from "../server/mention-lifecycle.mjs";

function room(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-events-read-scale-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom());
  return store;
}

function addMember(store, ownerKey, memberId) {
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: memberId, kind: "agent", permissions: [] } });
  return store.issueAccessKey("commons", memberId);
}

test("a mention-timeout flip on the read path keeps the projection cache warm", t => {
  const store = room(t);
  // Warm the projection cache; room() returns the identical frozen value on a hit.
  const before = store.room("commons");
  // One expired mention row forces the flip down its write path.
  store.db.exec(mentionStateSchema);
  store.db.prepare(
    "INSERT INTO mention_states(room_id, message_event_id, mentioned_member_id, state, created_at, timeout_at) VALUES (?,?,?,?,?,?)"
  ).run("commons", "evt-1", "owner", "delivered", 1, 1);
  const flipped = store.flipExpiredMentions("commons");
  assert.equal(flipped, 1, "the flip took its write path");
  const state = store.db.prepare(
    "SELECT state FROM mention_states WHERE room_id=? AND message_event_id=?").get("commons", "evt-1").state;
  assert.equal(state, "timed_out", "the flip still applies");
  const after = store.room("commons");
  assert.equal(after, before, "projection cache survived the flip (same object identity)");
});

test("paged reads stay complete and ordered across DM-filtered gaps", t => {
  const store = room(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const aliceKey = addMember(store, ownerKey, "alice");
  const bobKey = addMember(store, ownerKey, "bob");
  // Interleave public messages with DMs addressed to alice. Bob is not a
  // party to the DMs, so his pages contain filtered gaps of varying width.
  const posted = [];
  for (let i = 0; i < 30; i++) {
    const dm = i % 3 === 1; // gaps of 1..2 filtered rows between visible ones
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: `m-${i}`, body: `message ${i}`, ...(dm ? { toMemberId: "alice" } : {}) } });
    const seq = store.db.prepare(
      "SELECT sequence FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(`m-${i}`).sequence;
    posted.push({ seq, dm, index: i });
  }

  // Reference: the owner sees the whole log. Bob's expectation is the owner
  // view minus the DM rows he is not a party to.
  const dmSeqs = new Set(posted.filter(p => p.dm).map(p => p.seq));
  const ownerSeqs = [];
  let oAfter = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = store.eventsAfter(ownerKey, "commons", oAfter, 9);
    ownerSeqs.push(...page.events.map(r => r.sequence));
    if (!page.hasMore) break;
    oAfter = page.next;
  }
  const expectedBob = ownerSeqs.filter(s => !dmSeqs.has(s));

  // Bob pages with an odd, small limit so every page boundary lands mid-gap.
  const seen = [];
  let after = 0, pages = 0, lastNext = -1;
  for (let guard = 0; guard < 100; guard++) {
    const page = store.eventsAfter(bobKey, "commons", after, 4);
    pages++;
    assert.ok(page.next >= after, `cursor went backwards: ${page.next} < ${after}`);
    assert.ok(page.next > lastNext || !page.hasMore, "cursor must advance while hasMore");
    lastNext = page.next;
    for (const row of page.events) {
      assert.ok(row.sequence > (seen.at(-1)?.sequence ?? -1), "sequences ascend within and across pages");
      seen.push(row);
    }
    if (!page.hasMore) break;
    after = page.next;
  }
  assert.deepEqual(seen.map(r => r.sequence), expectedBob,
    "bob sees every visible event exactly once, in order, with no DM rows");
  assert.equal(pages > 2, true, `expected several pages, took ${pages}`);
  const head = store.roomAuthority("commons").sequence;
  const lastPage = store.eventsAfter(bobKey, "commons", lastNext, 4);
  assert.equal(lastPage.hasMore, false);
  assert.equal(lastPage.next, head, "final cursor rests at the room head");

  // The DM party still sees everything, exactly once.
  const aliceSeen = [];
  let aAfter = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = store.eventsAfter(aliceKey, "commons", aAfter, 4);
    aliceSeen.push(...page.events.map(r => r.sequence));
    if (!page.hasMore) break;
    aAfter = page.next;
  }
  assert.deepEqual(aliceSeen, ownerSeqs, "alice sees the full log, no drops, no dupes");
});
