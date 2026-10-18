// STORAGE-S1: patrol idempotency look-back over a generated column.
//
// Patrol's look-back (server/patrol.mjs) runs once per patrol batch that
// carries idempotency keys. Its original form extracts
// `$.idempotencyKey` from every event body from sequence 1 to the batch
// start — O(room history) per batch (research lane 02-storage Q4: 22.2 ms
// at 20,000 events). The fix is ONE additive VIRTUAL generated column,
// ev_idempotency_key, plus the (room_id, ev_idempotency_key, sequence)
// index, converged by ensureEventIdempotencyKeySchema in the store schema
// pass (registered in ADDITIVE_SCHEMA_ENSURES, so the schema stamp covers
// it) — no schema-version bump: PR #3820 owns v39, and its seven columns
// (ev_type, ev_actor_id, ev_at, ev_work_item_id, ev_message_id,
// ev_member_id, ev_to_member_id) are disjoint from this one, so the two
// sets compose when #3820 lands.
//
// Proof in four parts:
//  1. A fresh store carries the column + index at schema v38 (unchanged),
//     with the stored events columns untouched.
//  2. A legacy-shaped store (column + index dropped) reconverges on open,
//     event bodies byte-identical.
//  3. Result equivalence: the column-form look-back deep-equals the
//     json_extract baseline on a shaped 20,000-event store, its plan is a
//     SEARCH over events_room_idempotency, and a full patrol run over a
//     key-shaped log files exactly the same findings with the column
//     (index form) and without it (json_extract fallback) — including a
//     prior key used twice, whose firstSequence must resolve to the
//     highest prior sequence in both forms.
//  4. Shaped benchmark on the same 20,000-event store: the column form is
//     at least 10x faster than the json_extract baseline arm in the same
//     process and lands in the sub-5 ms class.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "patrol-idem-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "room.sqlite");
}

const generatedColumns = db =>
  db.prepare("SELECT name FROM pragma_table_xinfo('events') WHERE hidden IN (2, 3)").all().map(row => row.name);
const storedColumns = db =>
  db.prepare("SELECT name FROM pragma_table_info('events')").all().map(row => row.name);
const indexSql = (db, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql ?? null;

test("no bare INSERT INTO events VALUES remains in server code (workerd rejects it once a generated column exists)", () => {
  // Node's SQLite tolerates an INSERT with no column list into a table
  // that has generated columns; the Durable Object SQLite does not
  // ("cannot INSERT into generated column" — the failure PR #3820's
  // hosted cloudflare check caught for its columns). This lane adds a
  // generated column independently of #3820, so it carries the same fix:
  // every events insert in server/ names the stored columns explicitly.
  const offenders = [];
  for (const entry of readdirSync(new URL("../server/", import.meta.url))) {
    if (!entry.endsWith(".mjs")) continue;
    const source = readFileSync(new URL(`../server/${entry}`, import.meta.url), "utf8");
    if (/INSERT INTO events VALUES/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});

test("fresh store converges the patrol idempotency column + index without a schema version bump", t => {
  const store = new RoomStore(tempStore(t));
  t.after(() => store.close());
  assert.equal(STORE_SCHEMA_VERSION, 38, "STORAGE-S1 is additive; the v39 bump stays PR #3820's");
  assert.deepEqual(generatedColumns(store.db), ["ev_idempotency_key"]);
  assert.deepEqual(storedColumns(store.db), ["room_id", "sequence", "id", "body"],
    "stored events columns are untouched; the generated column costs no row bytes");
  const sql = indexSql(store.db, "events_room_idempotency");
  assert.ok(sql && sql.includes("(room_id, ev_idempotency_key, sequence)"), `index missing or misshaped: ${sql}`);
});

test("a legacy-shaped store (no column, no index) reconverges on open, bodies byte-identical", t => {
  const filename = tempStore(t);
  const body = JSON.stringify({ id: "ev-1", type: "message.posted", idempotencyKey: "key-1", data: { messageId: "m1" } });
  {
    const store = new RoomStore(filename);
    store.db.prepare("INSERT INTO rooms(id, sequence, projection) VALUES(?, ?, ?)").run("room-1", 1, "{}");
    store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES(?, ?, ?, ?)").run("room-1", 1, "ev-1", body);
    store.db.exec("DROP INDEX IF EXISTS events_room_idempotency");
    store.db.exec("ALTER TABLE events DROP COLUMN ev_idempotency_key");
    assert.deepEqual(generatedColumns(store.db), []);
    store.close();
  }
  const migrated = new RoomStore(filename);
  t.after(() => migrated.close());
  assert.deepEqual(generatedColumns(migrated.db), ["ev_idempotency_key"]);
  assert.ok(indexSql(migrated.db, "events_room_idempotency"), "index must be recreated on open");
  const row = migrated.db.prepare("SELECT body, ev_idempotency_key FROM events WHERE room_id='room-1'").get();
  assert.equal(row.body, body, "event body must be byte-identical after convergence");
  assert.equal(row.ev_idempotency_key, "key-1");
});

// --- Shaped store: 20,000 events, research-lane shape (~200 B bodies,
// idempotency keys at every 5,000th event) ---

const N = 20000;
const ROOM = "bench-room";
const KEYS = ["key5000", "key10000", "key15000"];
function fillShaped(store) {
  const insert = store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES(?, ?, ?, ?)");
  store.db.exec("BEGIN");
  for (let i = 1; i <= N; i++) {
    const body = { id: `ev-${i}`, type: "note", actorId: "a1", at: "2026-10-01T00:00:00.000Z", data: { filler: "x".repeat(120) + i } };
    if (i % 5000 === 0) body.idempotencyKey = `key${i}`;
    insert.run(ROOM, i, `ev-${i}`, JSON.stringify(body));
  }
  store.db.exec("COMMIT");
}
const BASELINE_SQL = `SELECT sequence, json_extract(body, '$.idempotencyKey') AS k
  FROM events WHERE room_id=? AND sequence<=? AND json_extract(body, '$.idempotencyKey') IN (?, ?, ?)`;
const COLUMN_SQL = `SELECT sequence, ev_idempotency_key AS k
  FROM events WHERE room_id=? AND sequence<=? AND ev_idempotency_key IN (?, ?, ?)`;

test("column look-back deep-equals the json_extract baseline and plans as an index SEARCH", t => {
  const store = new RoomStore(tempStore(t));
  t.after(() => store.close());
  store.db.prepare("INSERT INTO rooms(id, sequence, projection) VALUES(?, ?, ?)").run(ROOM, N, "{}");
  fillShaped(store);
  const args = [ROOM, N, ...KEYS];
  const baseline = store.db.prepare(BASELINE_SQL).all(...args);
  const column = store.db.prepare(COLUMN_SQL).all(...args);
  assert.equal(baseline.length, 3);
  // Same rows, same values: the two plans iterate in different orders
  // (baseline in sequence order via the PK, column form grouped by key via
  // the index), so compare as sets sorted by sequence. The patrol consumes
  // the rows through a Map keyed by k, and within any one key both plans
  // iterate sequences ascending — the patrol-level test below pins the
  // observable semantics (the filed findings) as identical.
  const bySequence = rows => rows.map(row => ({ sequence: row.sequence, k: row.k })).sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(bySequence(column), bySequence(baseline), "the column form must return exactly the baseline rows");
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${COLUMN_SQL}`).all(...args).map(row => row.detail).join(" | ");
  assert.match(plan, /SEARCH events USING INDEX events_room_idempotency \(room_id=\? AND ev_idempotency_key=\?/,
    `look-back must be served by events_room_idempotency, got: ${plan}`);
  assert.ok(!/SCAN events/.test(plan), `look-back must not scan events, got: ${plan}`);
});

test("shaped benchmark: column look-back is >=10x the json_extract baseline and <5 ms median", t => {
  const store = new RoomStore(tempStore(t));
  t.after(() => store.close());
  store.db.prepare("INSERT INTO rooms(id, sequence, projection) VALUES(?, ?, ?)").run(ROOM, N, "{}");
  fillShaped(store);
  const args = [ROOM, N, ...KEYS];
  const median = sql => {
    const stmt = store.db.prepare(sql);
    stmt.all(...args); // warm
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      stmt.all(...args);
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[7];
  };
  const baselineMs = median(BASELINE_SQL);
  const columnMs = median(COLUMN_SQL);
  assert.ok(columnMs < 5, `column look-back median ${columnMs.toFixed(3)} ms must be in the sub-5 ms class`);
  assert.ok(baselineMs / columnMs >= 10,
    `column look-back must be >=10x the baseline (baseline ${baselineMs.toFixed(3)} ms, column ${columnMs.toFixed(3)} ms)`);
});

// --- Patrol-level equivalence: identical findings with and without the
// column. The log is shaped so the look-back (not the in-batch check) is
// what files the reuse findings, and one prior key is used twice so
// firstSequence must resolve to the highest prior sequence. ---

function keyLogScenario(t, { dropColumn }) {
  const store = new RoomStore(tempStore(t));
  t.after(() => store.close());
  store.initialize(initialRoom("alpha"));
  // initialize() writes the room's own first event; the shaped log starts
  // right after it, and every expected sequence below is relative to it.
  const base = store.db.prepare("SELECT sequence FROM rooms WHERE id='alpha'").get().sequence;
  const insert = store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES(?, ?, ?, ?)");
  const put = (offset, key) => {
    const sequence = base + offset;
    const event = { id: `ev-${sequence}`, type: "note", data: {} };
    if (key) event.idempotencyKey = key;
    insert.run("alpha", sequence, event.id, JSON.stringify(event));
  };
  put(1, "alpha-key");
  put(2, "multi-key");
  put(3, "multi-key");
  for (let offset = 4; offset <= 149; offset++) put(offset, null);
  put(150, "alpha-key");
  put(151, "multi-key");
  put(152, "solo-key");
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='alpha'").run(base + 152);
  if (dropColumn) {
    store.db.exec("DROP INDEX IF EXISTS events_room_idempotency");
    store.db.exec("ALTER TABLE events DROP COLUMN ev_idempotency_key");
    assert.deepEqual(generatedColumns(store.db), [], "legacy arm must really lack the column");
  }
  // First tick tails the room's own event plus the three prior key uses
  // (batchStart 0: the in-batch check files the seq+3 duplicate). The
  // second tick's batch starts after them, so its reuse findings can only
  // come from the look-back — the query this lane converts.
  store.patrolTick({ limit: base + 3 });
  const result = store.patrolTick();
  assert.equal(result.errors, undefined);
  return store.patrolFindings()
    .filter(f => f.kind === "idempotency_duplicate")
    .map(f => ({ sequence: f.sequence - base, detail: { firstSequence: f.detail.firstSequence - base, sequence: f.detail.sequence - base } }))
    .sort((a, b) => a.sequence - b.sequence);
}

test("patrol files identical idempotency findings with the column and on a legacy-shaped store", t => {
  const expected = [
    { sequence: 3, detail: { firstSequence: 2, sequence: 3 } },
    { sequence: 150, detail: { firstSequence: 1, sequence: 150 } },
    { sequence: 151, detail: { firstSequence: 3, sequence: 151 } }
  ];
  assert.deepEqual(keyLogScenario(t, { dropColumn: false }), expected,
    "column form: look-back findings must match the pre-change semantics exactly");
  assert.deepEqual(keyLogScenario(t, { dropColumn: true }), expected,
    "legacy form (json_extract fallback) must file byte-identical findings");
});
