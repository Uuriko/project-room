// PERF-10X L1 (schema v39): VIRTUAL generated columns over the hot event
// fields + named indexes. Proof in three parts:
//  1. A v38-shaped database (no generated columns, legacy expression type
//     index, v38 writer fence) migrates on open: columns and named indexes
//     appear, the expression index is replaced, event rows are untouched.
//  2. EXPLAIN QUERY PLAN assertions for the six hot query shapes from the
//     Phase A probe (11-probe-idx.md): every shape resolves through a
//     named events_* index, never a bare SCAN of events.
//  3. A shaped benchmark on 20,000 events (~845 B bodies, the probe's
//     shape): the five shapes the old type-only index did not help move
//     from the 37-126 ms scan class to the index class, each at least
//     4-10x faster than the same shape written with json_extract over an
//     unindexed table (the probe's unindexed arm).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, EVENT_GENERATED_COLUMNS, EVENT_INDEX_SCHEMA } from "../server/store.mjs";
import { fenceDefinitions, STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";

const COLUMN_NAMES = EVENT_GENERATED_COLUMNS.map(([name]) => name);
const INDEX_NAMES = [...EVENT_INDEX_SCHEMA.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]);

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "event-indexes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, filename: join(dir, "room.sqlite") };
}

function eventColumns(db) {
  return db.prepare("SELECT name FROM pragma_table_xinfo('events') WHERE hidden IN (2, 3)").all().map(row => row.name).sort();
}

function eventIndexes(db) {
  return new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='events' AND sql IS NOT NULL").all()
    .map(row => [row.name, row.sql]));
}

test("no bare INSERT INTO events VALUES remains in server code (workerd rejects it)", () => {
  // Node's SQLite tolerates an INSERT with no column list into a table
  // that has generated columns; the Durable Object SQLite does not
  // ("cannot INSERT into generated column ev_type" — caught only by the
  // hosted cloudflare check). Every events insert must name the stored
  // columns explicitly.
  const offenders = [];
  for (const entry of readdirSync(new URL("../server/", import.meta.url))) {
    if (!entry.endsWith(".mjs")) continue;
    const source = readFileSync(new URL(`../server/${entry}`, import.meta.url), "utf8");
    if (/INSERT INTO events VALUES/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});

test("fresh store carries the v39 generated columns and named indexes", t => {
  const { filename } = tempStore(t);
  const store = new RoomStore(filename);
  t.after(() => store.close());
  assert.equal(STORE_SCHEMA_VERSION, 39);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 39);
  assert.deepEqual(eventColumns(store.db), [...COLUMN_NAMES].sort());
  const indexes = eventIndexes(store.db);
  for (const name of INDEX_NAMES) assert.ok(indexes.has(name), `${name} missing`);
  assert.ok(!indexes.get("events_room_type").includes("json_extract"), "type index must be over ev_type, not an expression");
  // Events table stays well inside the DO SQL 100-column cap: 4 stored + 7 generated.
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM pragma_table_xinfo('events')").get().n, 11);
});

test("a v38-shaped database migrates to v39 columns and indexes without touching event rows", t => {
  const { filename } = tempStore(t);
  const body = JSON.stringify({ id: "ev-1", type: "message.posted", actorId: "actor-1", at: "2026-10-16T00:00:00.000Z", data: { messageId: "msg-1", toMemberId: "member-2" } });
  {
    const store = new RoomStore(filename);
    store.db.prepare("INSERT INTO rooms(id, sequence, projection) VALUES(?, ?, ?)").run("room-1", 1, "{}");
    store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?, ?, ?, ?)").run("room-1", 1, "ev-1", body);
    store.close();
  }
  // Downgrade the file to the v38 shape: drop the v39 indexes and
  // generated columns, restore the legacy expression type index, and
  // reinstall the v38 writer fence at user_version 38.
  {
    const raw = new DatabaseSync(filename);
    for (let v = 6; v <= STORE_SCHEMA_VERSION; v++) raw.function(`project_room_writer_v${v}`, () => v);
    for (const name of INDEX_NAMES) raw.exec(`DROP INDEX IF EXISTS ${name}`);
    for (const name of COLUMN_NAMES) raw.exec(`ALTER TABLE events DROP COLUMN ${name}`);
    raw.exec("CREATE INDEX events_room_type ON events(room_id, json_extract(body, '$.type'))");
    for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v39_*'").all()) raw.exec(`DROP TRIGGER ${row.name}`);
    for (const { sql } of fenceDefinitions(38)) raw.exec(sql);
    raw.exec("PRAGMA user_version=38");
    assert.deepEqual(eventColumns(raw), []);
    raw.close();
  }
  const migrated = new RoomStore(filename);
  t.after(() => migrated.close());
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 39);
  assert.deepEqual(eventColumns(migrated.db), [...COLUMN_NAMES].sort());
  const indexes = eventIndexes(migrated.db);
  for (const name of INDEX_NAMES) assert.ok(indexes.has(name), `${name} missing after migration`);
  assert.ok(!indexes.get("events_room_type").includes("json_extract"), "legacy expression index must be replaced");
  const row = migrated.db.prepare("SELECT body, ev_type, ev_actor_id, ev_message_id, ev_to_member_id FROM events WHERE room_id='room-1'").get();
  assert.equal(row.body, body, "event body must be byte-identical after migration");
  assert.deepEqual([row.ev_type, row.ev_actor_id, row.ev_message_id, row.ev_to_member_id],
    ["message.posted", "actor-1", "msg-1", "member-2"]);
});

// --- Shaped benchmark (20k events, probe shape) ---

const N = 20000;
const ROOM = "bench-room";
const TYPES = ["message.posted", "work.proposed", "work.updated", "session.started", "session.status_changed", "member.added", "message.posted", "work.claim.updated"];
const BODIES = [];
for (let i = 0; i < N; i++) {
  const type = TYPES[i % TYPES.length];
  const data = { filler: "x".repeat(700) + i };
  if (type.startsWith("work.") || type.startsWith("session.")) data.workItemId = `work-${i % 500}`;
  if (type === "message.posted") { data.messageId = `msg-${i}`; if (i % 3 === 0) data.toMemberId = `member-${i % 40}`; }
  if (type === "member.added") data.memberId = `member-${i % 40}`;
  if (type === "member.access_changed") data.memberId = `member-${i % 40}`;
  BODIES.push(JSON.stringify({ id: `ev-${i}`, type, actorId: `actor-${i % 40}`, at: new Date(1700000000000 + i * 1000).toISOString(), data }));
}
// A member.access_changed event so Q2 has a winning row. It sits near the
// START of the log on purpose: Q2's baseline form scans backward from the
// newest event (primary-key order, LIMIT 1), so a late winning row would
// short-circuit the scan and hide the cost this benchmark exists to show.
BODIES[99] = JSON.stringify({ id: "ev-99", type: "member.access_changed", actorId: "member-7", at: new Date(1700000000000 + 99 * 1000).toISOString(), data: { memberId: "member-7", active: false } });

function fillEvents(db, ownTransaction = true) {
  const insert = db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?, ?, ?, ?)");
  if (ownTransaction) db.exec("BEGIN");
  for (let i = 0; i < N; i++) insert.run(ROOM, i + 1, `ev-${i}`, BODIES[i]);
  if (ownTransaction) db.exec("COMMIT");
}

const SINCE = new Date(1700000000000 + 10000 * 1000).toISOString();
// [name, baseline (json_extract, unindexed), indexed (generated columns), args, minRatio, maxIndexedMs]
const SHAPES = [
  ["Q1 type count",
    "SELECT count(*) AS n FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted'",
    "SELECT count(*) AS n FROM events WHERE room_id=? AND ev_type='message.posted'",
    [ROOM], 10, 5],
  ["Q2 type+member latest 1",
    "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? AND json_extract(body,'$.data.memberId')=? ORDER BY sequence DESC LIMIT 1",
    "SELECT body FROM events WHERE room_id=? AND ev_type=? AND ev_member_id=? ORDER BY sequence DESC LIMIT 1",
    [ROOM, "member.access_changed", "member-7"], 10, 5],
  ["Q3 workItemId only",
    "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence",
    "SELECT body FROM events WHERE room_id=? AND ev_work_item_id=? ORDER BY sequence",
    [ROOM, "work-42"], 10, 5],
  // Q4/Q5 cannot reach the ~1 ms point-lookup class by construction: Q4
  // aggregates every actor in the room and Q5 returns thousands of rows.
  // Their proof is the plan (named index, no SCAN) plus the ratio against
  // the same-process baseline; the absolute cap only guards against a
  // regression back to parsing bodies (which measures >= 150 ms here).
  ["Q4 actor latest, GROUP BY actor",
    "SELECT json_extract(body,'$.actorId') AS actor, max(json_extract(body,'$.at')) AS at FROM events WHERE room_id=? GROUP BY actor",
    "SELECT ev_actor_id AS actor, max(ev_at) AS at FROM events WHERE room_id=? GROUP BY actor",
    [ROOM], 4, 100],
  ["Q5 usage summary (type IN + at>=)",
    "SELECT json_extract(body,'$.type') AS type FROM events WHERE room_id=? AND json_extract(body,'$.type') IN ('session.started','session.status_changed','session.stopped') AND json_extract(body,'$.at')>=? ORDER BY sequence",
    "SELECT ev_type AS type FROM events INDEXED BY events_room_type_at WHERE room_id=? AND ev_type IN ('session.started','session.status_changed','session.stopped') AND ev_at>=? ORDER BY sequence",
    [ROOM, SINCE], 4, 100],
  ["Q6 type + toMemberId (DM scan)",
    "SELECT sequence, body FROM events WHERE room_id=? AND sequence>? AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.toMemberId')=? ORDER BY sequence ASC LIMIT 21",
    "SELECT sequence, body FROM events WHERE room_id=? AND sequence>? AND ev_type='message.posted' AND ev_to_member_id=? ORDER BY sequence ASC LIMIT 21",
    [ROOM, 0, "member-9"], 10, 5]
];

function medianMs(db, sql, args, runs = 15) {
  const statement = db.prepare(sql);
  statement.all(...args); // warm-up
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    statement.all(...args);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

test("the six hot shapes use named indexes (no SCAN) and leave the scan class behind", t => {
  const { filename } = tempStore(t);
  const store = new RoomStore(filename);
  t.after(() => store.close());
  store.db.prepare("INSERT INTO rooms(id, sequence, projection) VALUES(?, ?, ?)").run(ROOM, N, "{}");
  store.transaction(() => fillEvents(store.db, false));

  const baseline = new DatabaseSync(":memory:");
  t.after(() => baseline.close());
  baseline.exec("CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence))");
  fillEvents(baseline);

  for (const [name, baselineSql, indexedSql, args, minRatio, maxIndexedMs] of SHAPES) {
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${indexedSql}`).all(...args).map(row => row.detail).join(" | ");
    assert.match(plan, /SEARCH events USING INDEX events_/, `${name}: expected a named-index SEARCH, got: ${plan}`);
    assert.ok(!/(^|\| )SCAN events( |$|\|)/.test(plan), `${name}: plan must not SCAN events: ${plan}`);
    // Same result on both arms: the rewrite must not change semantics.
    assert.deepEqual(store.db.prepare(indexedSql).all(...args), baseline.prepare(baselineSql).all(...args), `${name}: indexed and baseline results differ`);
    const baselineMs = medianMs(baseline, baselineSql, args, 7);
    const indexedMs = medianMs(store.db, indexedSql, args);
    assert.ok(indexedMs < maxIndexedMs, `${name}: indexed median ${indexedMs.toFixed(2)} ms is not in the index class (< ${maxIndexedMs} ms)`);
    assert.ok(baselineMs / indexedMs >= minRatio, `${name}: speedup ${(baselineMs / indexedMs).toFixed(1)}x < ${minRatio}x (baseline ${baselineMs.toFixed(2)} ms, indexed ${indexedMs.toFixed(2)} ms)`);
  }
});
