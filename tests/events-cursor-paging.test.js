import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// GET /api/rooms/:room/events publishes a next/hasMore paging contract
// (docs/SERVICE.md). With an audit filter it could not terminate: `next` came
// from the last RETURNED row, so an empty filtered page handed the caller back
// their own cursor, while `hasMore` was measured against the room's unfiltered
// sequence and stayed true. A client following the documented contract asked
// for the same empty page forever.
//
// The cursor has to advance by what was scanned, not by what matched.

function room(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-events-cursor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const id of ["alice", "bob"]) {
    send("owner", T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "human", permissions: ["steer"] });
    keys[id] = store.issueAccessKey("commons", id);
  }
  return { store, send, keys };
}

// Follow the documented contract exactly, with a hard stop so a loop is a
// failure rather than a hung suite.
function pageThrough(store, token, options = {}, limit = 100) {
  const pages = [];
  let after = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = store.eventsAfter(token, "commons", after, limit, null, options);
    pages.push(page);
    assert.ok(page.next >= after, `the cursor went backwards: ${page.next} < ${after}`);
    if (!page.hasMore) return { pages, events: pages.flatMap(entry => entry.events) };
    assert.notEqual(page.next, after, "a page that reports more must move the cursor");
    after = page.next;
  }
  assert.fail(`paging did not terminate after 50 pages (${JSON.stringify(pages.at(-1))})`);
}

test("a filtered scan terminates even when most of the log does not match", t => {
  const fixture = room(t);
  fixture.send("alice", T.MESSAGE_POSTED, { messageId: "a-1", body: "alice says one thing" });
  for (let index = 0; index < 10; index += 1) {
    fixture.send("bob", T.MESSAGE_POSTED, { messageId: `b-${index}`, body: `bob message ${index}` });
  }

  const { pages, events } = pageThrough(fixture.store, fixture.keys.owner, { actor: "alice" });
  assert.equal(events.length, 1, "alice's single event is returned once");
  assert.ok(pages.length <= 2, `should not need many pages, took ${pages.length}`);
  assert.equal(pages.at(-1).hasMore, false);
});

test("a filter matching nothing at all terminates on the first page", t => {
  const fixture = room(t);
  for (let index = 0; index < 5; index += 1) {
    fixture.send("bob", T.MESSAGE_POSTED, { messageId: `b-${index}`, body: `bob ${index}` });
  }
  const page = fixture.store.eventsAfter(fixture.keys.owner, "commons", 0, 100, null, { actor: "nobody" });
  assert.deepEqual(page.events, []);
  assert.equal(page.hasMore, false, "nothing matches and nothing ever will");
  assert.equal(page.next, fixture.store.room("commons").sequence);
});

test("paging a filter across several full pages returns every match exactly once", t => {
  const fixture = room(t);
  // Interleaved, so every page boundary lands between two non-matching rows.
  for (let index = 0; index < 12; index += 1) {
    fixture.send("alice", T.MESSAGE_POSTED, { messageId: `a-${index}`, body: `alice ${index}` });
    fixture.send("bob", T.MESSAGE_POSTED, { messageId: `b-${index}`, body: `bob ${index}` });
  }
  const { events } = pageThrough(fixture.store, fixture.keys.owner, { actor: "alice" }, 2);
  const ids = events.map(entry => entry.event.data.messageId);
  assert.equal(ids.length, 12, "every alice message, no more and no fewer");
  assert.deepEqual(ids, [...new Set(ids)], "and none of them twice");
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, index) => `a-${index}`), "in order");
});

test("unfiltered paging still returns the whole log exactly once", t => {
  const fixture = room(t);
  for (let index = 0; index < 9; index += 1) {
    fixture.send("bob", T.MESSAGE_POSTED, { messageId: `b-${index}`, body: `bob ${index}` });
  }
  const sequence = fixture.store.room("commons").sequence;
  const { events } = pageThrough(fixture.store, fixture.keys.owner, {}, 2);
  assert.equal(events.length, sequence, "every event in the room");
  assert.deepEqual(events.map(entry => entry.sequence), Array.from({ length: sequence }, (_, index) => index + 1));
});

test("a full page still reports more, so nothing is skipped at the boundary", t => {
  const fixture = room(t);
  for (let index = 0; index < 6; index += 1) {
    fixture.send("bob", T.MESSAGE_POSTED, { messageId: `b-${index}`, body: `bob ${index}` });
  }
  // Exactly `limit` rows come back, and the log continues past them: the cursor
  // must stay on the last returned row rather than jumping to the end.
  const page = fixture.store.eventsAfter(fixture.keys.owner, "commons", 0, 2);
  assert.equal(page.events.length, 2);
  assert.equal(page.next, 2, "the cursor sits on the last row actually returned");
  assert.equal(page.hasMore, true);
});

test("an until filter terminates rather than waiting for events it excludes", t => {
  const fixture = room(t);
  fixture.send("alice", T.MESSAGE_POSTED, { messageId: "a-1", body: "early" });
  const cutoff = new Date(Date.now() - 1000).toISOString();
  for (let index = 0; index < 4; index += 1) {
    fixture.send("bob", T.MESSAGE_POSTED, { messageId: `b-${index}`, body: `later ${index}` });
  }
  const { pages } = pageThrough(fixture.store, fixture.keys.owner, { until: cutoff });
  assert.equal(pages.at(-1).hasMore, false, "events after the cutoff are excluded, not pending");
});
