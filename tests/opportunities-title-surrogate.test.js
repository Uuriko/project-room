// A legal bounty title can be 256 UTF-16 units. The public feed keeps 200.
// Cutting on a code unit splits a surrogate pair, so a well-formed title
// leaves the feed ill-formed. Drive buildOpportunitiesFeed, the shipped reader.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildOpportunitiesFeed } from "../server/opportunities.mjs";

const ROOM = "commons";

function listedStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "opp-title-surrogate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.roomDirectory.set(ROOM, "owner", true);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedBounty(store, { bountyId, title, criteria }) {
  const now = store.now();
  store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms, deadline_ms, label, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    bountyId, ROOM, title, criteria, 5000, "poster-member",
    "funded", now, now + 3600e3, "test",
    new Date(now).toISOString(), new Date(now).toISOString());
}

test("a truncated opportunity title and criteria stay well-formed", t => {
  const store = listedStore(t);
  const title = "a".repeat(199) + "😀";
  const criteria = "b".repeat(499) + "😀";
  assert.equal(title.isWellFormed(), true);
  assert.equal(criteria.isWellFormed(), true);
  seedBounty(store, { bountyId: "b-emoji", title, criteria });
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  const opp = feed.opportunities.find(item => item.bountyId === "b-emoji");
  assert.ok(opp, "the funded bounty stays on the feed");
  assert.equal(opp.title.isWellFormed(), true);
  assert.equal(opp.criteria.isWellFormed(), true);
  assert.equal(opp.title, "a".repeat(199));
  assert.equal(opp.criteria, "b".repeat(499));
});

test("a short emoji title is not cut", t => {
  const store = listedStore(t);
  seedBounty(store, { bountyId: "b-short", title: "Ship 😀", criteria: "Done." });
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  const opp = feed.opportunities.find(item => item.bountyId === "b-short");
  assert.equal(opp.title, "Ship 😀");
  assert.equal(opp.title.isWellFormed(), true);
});
