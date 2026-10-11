// Opportunities title honesty: the public feed must never present a
// synthesized/fallback title as if it were the item's real title.
//
// Context: grok-opportunities-title-surrogate-1010 (UTF-16 surrogate-pair
// truncation in server/opportunities.mjs) is Grok Bot's lane — untouched here.
// This file probes the adjacent human-side honesty question: when an item has
// no real title, does the feed invent one? Drive buildOpportunitiesFeed, the
// shipped reader, against items whose stored title is blank.
//
// Current contract (pinned by tests/opportunities-feed-v2.test.js key sets):
// items without a usable title are dropped from the feed. The feed schema has
// no title-source/truncated marker, so `title` is always the stored title (or
// its well-formed 200-unit truncation) — never a placeholder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildOpportunitiesFeed } from "../server/opportunities.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ROOM = "commons";

function listedStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "opp-title-honesty-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.roomDirectory.set(ROOM, "owner", true);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

let cmdSeq = 0;
const cmdId = () => `opp-honesty-cmd-${++cmdSeq}`;

function openHelpWanted(store, ownerKey, workItemId, title) {
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_PROPOSED, data: {
    workItemId, title, definitionOfDone: "Done.", accountableMemberId: "owner",
    verifierMemberId: "owner", mode: "read" } });
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_HELP_UPDATED, data: {
    workItemId, expectedRevision: 1, expectedHelpRevision: 0, status: "open",
    scope: "Need a hand with this", expiresAt: new Date(Date.now() + 3600e3).toISOString() } });
}

function blankWorkItemTitle(store, workItemId, title) {
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(ROOM);
  const projection = JSON.parse(row.projection);
  assert.ok(projection.workItems?.[workItemId], "work item exists in projection");
  projection.workItems[workItemId].title = title;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), ROOM);
}

function seedBounty(store, { bountyId, title }) {
  const now = store.now();
  store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms, deadline_ms, label, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    bountyId, ROOM, title, "Do the thing", 5000, "poster-member",
    "funded", now, now + 3600e3, "test",
    new Date(now).toISOString(), new Date(now).toISOString());
}

test("a help-wanted work item with no real title is dropped, not given a fallback", t => {
  const store = listedStore(t);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  openHelpWanted(store, ownerKey, "w-blank", "Will be blanked");
  blankWorkItemTitle(store, "w-blank", "");
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  const opp = feed.opportunities.find(item => item.workItemId === "w-blank");
  assert.equal(opp, undefined, "untitled work item must not appear with a synthesized title");
});

test("a help-wanted work item with a whitespace-only title is dropped", t => {
  const store = listedStore(t);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  openHelpWanted(store, ownerKey, "w-ws", "Will be blanked");
  blankWorkItemTitle(store, "w-ws", "   ");
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  const opp = feed.opportunities.find(item => item.workItemId === "w-ws");
  assert.equal(opp, undefined, "whitespace-only title must not become a fallback title");
});

test("a bounty with no real title is dropped, not given a fallback", t => {
  const store = listedStore(t);
  seedBounty(store, { bountyId: "b-blank", title: "" });
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  assert.equal(feed.opportunities.find(item => item.bountyId === "b-blank"), undefined);
  // Schema note: bounty_records.title is NOT NULL, so a NULL title can never
  // reach the feed at all — the database itself refuses it.
});

test("a real title reaches the feed verbatim, never synthesized from the room", t => {
  const store = listedStore(t);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  openHelpWanted(store, ownerKey, "w-real", "Patch the onboarding copy");
  seedBounty(store, { bountyId: "b-real", title: "Fix the retry backoff" });
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  const work = feed.opportunities.find(item => item.workItemId === "w-real");
  const bounty = feed.opportunities.find(item => item.bountyId === "b-real");
  assert.ok(work, "titled work item stays on the feed");
  assert.ok(bounty, "titled bounty stays on the feed");
  assert.equal(work.title, "Patch the onboarding copy");
  assert.equal(bounty.title, "Fix the retry backoff");
});
