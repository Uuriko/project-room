// RR-D6: opportunities feed derived snapshots. The feed memoises the
// DERIVED per-room snapshot (title + help-wanted candidate fields) keyed
// by the projection content hash, for rooms of ANY size — pre-change, a
// projection over 1 MB bypassed the memo and was JSON-parsed on every
// request. Failing-first: the parse-count assertions fail at pre-change
// main for the oversized room (2 parses across 2 calls, not 1).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildOpportunitiesFeed } from "../server/opportunities.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";

const NOW = Date.parse("2026-10-28T00:00:00.000Z");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL DEFAULT 0, projection TEXT NOT NULL, archived_at TEXT)");
  db.exec(roomDirectorySchema);
  db.exec(publicUnpublishSchema);
  db.exec(`CREATE TABLE bounty_records (bounty_id TEXT, room_id TEXT, title TEXT, criteria TEXT,
    amount_millis INTEGER, state TEXT, deadline_ms INTEGER, label TEXT, created_at TEXT)`);
  // hydrateWorkItems reads the work-item side tables; empty tables keep
  // the projection's own workItems authoritative for this fixture.
  db.exec("CREATE TABLE IF NOT EXISTS work_items (room_id TEXT, item_id TEXT, item_json TEXT)");
  return db;
}

function seedRoom(db, { id, title, padBytes = 0 }) {
  const projection = {
    room: { id, title },
    members: {},
    messages: [],
    workItems: {
      w1: {
        id: "w1", title: "Help with the thing", definitionOfDone: "Done.", state: "accepted",
        mode: "read", labels: ["newcomer-safe"],
        helpWanted: { status: "open", scope: "Need a hand", expiresAt: "2027-01-01T00:00:00.000Z", openedAt: "2026-10-01T00:00:00.000Z" }
      }
    }
  };
  let text = JSON.stringify(projection);
  if (padBytes > 0) text += " ".repeat(padBytes); // JSON.parse tolerates trailing space; bytes grow, content does not
  db.prepare("INSERT INTO rooms (id, projection) VALUES (?, ?)").run(id, text);
  db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, opportunities_enabled) VALUES (?, 1, 1, 1, 1)").run(id);
  return text;
}

function countBigParses(fn) {
  const original = JSON.parse;
  let big = 0;
  JSON.parse = (text, ...rest) => { if (typeof text === "string" && text.length > 1_000_000) big += 1; return original(text, ...rest); };
  try { return { out: fn(), big }; }
  finally { JSON.parse = original; }
}

test("oversized room: derived once per content, not parsed per request", () => {
  const db = makeDb();
  seedRoom(db, { id: "big-room", title: "Big Room", padBytes: 1_200_000 });
  const store = { db };
  const first = countBigParses(() => buildOpportunitiesFeed(store, { now: NOW }));
  assert.equal(first.out.opportunities.length, 1);
  assert.equal(first.out.opportunities[0].roomTitle, "Big Room");
  assert.equal(first.big, 1);
  const second = countBigParses(() => buildOpportunitiesFeed(store, { now: NOW }));
  assert.deepEqual(second.out.opportunities, first.out.opportunities);
  assert.equal(second.big, 0); // snapshot hit: no re-parse of the 1.2 MB projection
});

test("a byte change at the same sequence re-derives (content key, RR-C3 §3.2)", () => {
  const db = makeDb();
  seedRoom(db, { id: "room-x", title: "Before" });
  const store = { db };
  assert.equal(buildOpportunitiesFeed(store, { now: NOW }).opportunities[0].roomTitle, "Before");
  const row = db.prepare("SELECT projection FROM rooms WHERE id='room-x'").get();
  db.prepare("UPDATE rooms SET projection=? WHERE id='room-x'").run(row.projection.replace("Before", "After!"));
  assert.equal(buildOpportunitiesFeed(store, { now: NOW }).opportunities[0].roomTitle, "After!");
});

test("help-wanted expiry is evaluated per request, not frozen in the snapshot", () => {
  const db = makeDb();
  seedRoom(db, { id: "room-y", title: "Expiring" });
  const store = { db };
  assert.equal(buildOpportunitiesFeed(store, { now: NOW }).opportunities.length, 1);
  const afterExpiry = Date.parse("2027-06-01T00:00:00.000Z");
  assert.equal(buildOpportunitiesFeed(store, { now: afterExpiry }).opportunities.length, 0);
});
