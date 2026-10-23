// #3948 (QB-01): the agent inbox's after-cursor silently lost messages.
// Both event-log lists (directMessages, directMentions) read DESC+LIMIT
// and the cursor took the MAX returned sequence, so a burst larger than
// the page between polls was permanently unreachable — and no signal
// said so. Separately, `after` beyond the room head was accepted and
// then suppressed everything under it, where the events door refuses
// the same condition with 409 cursor_ahead.
//
// Contract after the fix: the scan walks ASCENDING from the cursor
// (pages are still displayed newest-first), the cursor is the page's
// own max, cursor.hasMore says when another page already exists, and
// an ahead cursor is refused exactly like the events door.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  t.after(() => store.close());
  const post = body => store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: body });
  return { store, agentKey, post };
}

test("#3948: five DMs at limit=2 are all reachable by cursor walking", t => {
  const { store, agentKey, post } = fixture(t);
  for (const id of ["dm1", "dm2", "dm3", "dm4", "dm5"]) post({ messageId: id, body: `note ${id}`, toMemberId: "agent" });
  const seen = [];
  let after = 0, pages = 0;
  for (;;) {
    const inbox = store.agentInbox(agentKey, "commons", { limit: 2, after });
    pages++;
    assert.ok(inbox.directMessages.length <= 2);
    // Display stays newest-first within the page (#3922 contract).
    const seqs = inbox.directMessages.map(row => row.sequence);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
    seen.push(...inbox.directMessages.map(row => row.messageId));
    if (!inbox.cursor.hasMore) { after = inbox.cursor.after; break; }
    assert.ok(inbox.cursor.after > after, "the cursor advances while pages remain");
    after = inbox.cursor.after;
    assert.ok(pages < 6, "the walk terminates");
  }
  assert.deepEqual([...seen].sort(), ["dm1", "dm2", "dm3", "dm4", "dm5"],
    "every DM in the burst is delivered exactly across the walk — none skipped");
  const steady = store.agentInbox(agentKey, "commons", { limit: 2, after });
  assert.deepEqual(steady.directMessages, []);
  assert.equal(steady.cursor.hasMore, false);
});

test("#3948: mentions walk the same way — a burst larger than the page is reachable", t => {
  const { store, agentKey, post } = fixture(t);
  for (const id of ["m1", "m2", "m3"]) post({ messageId: id, body: `@agent question ${id}` });
  const seen = [];
  let after = 0;
  for (let guard = 0; guard < 5; guard++) {
    const inbox = store.agentInbox(agentKey, "commons", { limit: 2, after });
    seen.push(...inbox.directMentions.map(row => row.messageId));
    after = inbox.cursor.after;
    if (!inbox.cursor.hasMore) break;
  }
  assert.deepEqual([...seen].sort(), ["m1", "m2", "m3"]);
});

test("#3948: an after cursor beyond the room head is refused 409 cursor_ahead, like the events door", t => {
  const { store, agentKey, post } = fixture(t);
  post({ messageId: "dm1", body: "note", toMemberId: "agent" });
  assert.throws(() => store.agentInbox(agentKey, "commons", { after: 999999 }),
    error => error.status === 409 && error.code === "cursor_ahead");
  // At the head exactly is fine and returns the empty steady state.
  const head = store.agentInbox(agentKey, "commons", { limit: 50 });
  const steady = store.agentInbox(agentKey, "commons", { after: head.cursor.after });
  assert.deepEqual(steady.directMessages, []);
});
