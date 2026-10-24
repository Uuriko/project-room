// History bytes live in the events table. The census counts them one room
// per wake. A death after the count is saved, and before the cursor moves,
// repeats that room instead of skipping it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JOBS } from "../server/jobs.mjs";
import { PILOT_LIMITS, RoomStore } from "../server/store.mjs";
import { STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";
import { runDurableAlarmTurn } from "../server/durable-alarm-turn.mjs";
import { recordWatchdogBeat, readWatchdogHealth } from "../server/job-watchdog-store.mjs";
import {
  historyCensusSummary, pageRoomHistory, refreshRoomHistoryCensus, sqliteHistoryEnabled
} from "../server/room-history.mjs";

const NOW = 1_700_000_000_000;
const CAP = PILOT_LIMITS.projectionBytes;

function seed(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL, archived_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
    PRIMARY KEY (room_id, sequence)
  )`);
}

function addRoom(db, id, projection, body) {
  db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 1, ?, NULL)").run(id, projection);
  db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?, 1, ?, ?)").run(id, `${id}-e1`, body);
}

test("event bytes can pass the projection cap while a page stays small", () => {
  const directory = mkdtempSync(join(tmpdir(), "room-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    const version = store.db.prepare("PRAGMA user_version").get().user_version;
    assert.equal(version, STORE_SCHEMA_VERSION);
    const projection = JSON.stringify({ ok: true });
    const body = JSON.stringify({ type: "message.posted", text: "x".repeat(CAP) });
    assert.ok(Buffer.byteLength(body) > CAP);
    assert.ok(Buffer.byteLength(projection) < CAP);
    store.db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES ('commons', 1, ?, NULL)").run(projection);
    store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES ('commons', 1, 'e1', ?)").run(body);
    store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES ('commons', 2, 'e2', ?)").run(
      JSON.stringify({ type: "message.posted", text: "second" })
    );
    const page = pageRoomHistory(store.db, "commons", { after: 0, limit: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0].type, "message.posted");
    assert.ok(page[0].bytes > CAP);
    assert.equal(Object.hasOwn(page[0], "body"), false);
    assert.equal(JSON.stringify(page).includes("\"text\""), false);
    const rest = pageRoomHistory(store.db, "commons", { after: page[0].sequence, limit: 100 });
    assert.equal(rest.length, 1);
    assert.equal(rest[0].id, "e2");
    assert.throws(() => pageRoomHistory(store.db, "../commons"), /room id/);
    const summary = refreshRoomHistoryCensus(store.db);
    assert.equal(summary.scanned, 1);
    assert.ok(summary.historyBytes > CAP);
    assert.ok(summary.largestProjectionBytes < CAP);
    assert.equal(summary.roomsAtCap, 0);
    assert.equal(store.db.prepare("SELECT after_room_id FROM room_history_cursor").get().after_room_id, "commons");
    const wrapped = refreshRoomHistoryCensus(store.db);
    assert.equal(wrapped.scanned, 0);
    assert.equal(store.db.prepare("SELECT after_room_id FROM room_history_cursor").get().after_room_id, "");
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, version);
    const watchdog = new DatabaseSync(":memory:");
    recordWatchdogBeat(watchdog, {
      objectName: "invite-only-pilot",
      progressAt: NOW,
      alarmAt: NOW + 30_000,
      snapshot: { status: "ok", jobs: [] },
      history: { ...historyCensusSummary(store.db), roomId: "commons" }
    }, NOW);
    const health = readWatchdogHealth(watchdog, NOW);
    assert.ok(health.watchdog.history.historyBytes > CAP);
    assert.equal(JSON.stringify(health).includes("commons"), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a census that dies before the cursor moves repeats the room", () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  addRoom(db, "commons", "{\"ok\":true}", JSON.stringify({ type: "message.posted" }));
  addRoom(db, "muse", "{\"ok\":true}", JSON.stringify({ type: "message.posted" }));
  let died = false;
  const flaky = {
    exec(sql) { db.exec(sql); },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        all: (...args) => statement.all(...args),
        get: (...args) => statement.get(...args),
        run: (...args) => {
          if (!died && sql.includes("INSERT INTO room_history_cursor")) {
            died = true;
            throw new Error("died");
          }
          return statement.run(...args);
        }
      };
    }
  };
  assert.throws(() => refreshRoomHistoryCensus(flaky), /died/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM room_history_census").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM room_history_cursor").get().n, 0);
  const again = refreshRoomHistoryCensus(flaky);
  assert.equal(again.scanned, 1);
  assert.equal(db.prepare("SELECT room_id FROM room_history_census").get().room_id, "commons");
  assert.equal(db.prepare("SELECT after_room_id FROM room_history_cursor").get().after_room_id, "commons");
  assert.equal(db.prepare("SELECT count(*) AS n FROM room_history_census").get().n, 1);
  refreshRoomHistoryCensus(db);
  assert.equal(db.prepare("SELECT after_room_id FROM room_history_cursor").get().after_room_id, "muse");
  assert.equal(refreshRoomHistoryCensus(db).scanned, 0);
  assert.equal(db.prepare("SELECT after_room_id FROM room_history_cursor").get().after_room_id, "");
});

test("the history flag is exact and a queue slice counts one room", async () => {
  assert.equal(sqliteHistoryEnabled({}), false);
  assert.equal(sqliteHistoryEnabled({ ROOM_SQLITE_HISTORY: "true" }), false);
  assert.equal(sqliteHistoryEnabled({ ROOM_SQLITE_HISTORY: "1" }), true);
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  for (const vars of [release.vars, release.env.production.vars, release.env.staging.vars]) {
    assert.equal(vars.ROOM_SQLITE_HISTORY, undefined);
  }
  const db = new DatabaseSync(":memory:");
  seed(db);
  addRoom(db, "commons", "{\"ok\":true}", JSON.stringify({ type: "message.posted", text: "x".repeat(64) }));
  addRoom(db, "muse", "{\"ok\":true}", JSON.stringify({ type: "message.posted" }));
  const env = { ROOM_DURABLE_ALARM_QUEUE: "1", ROOM_SQLITE_HISTORY: "1" };
  const lastRan = Object.fromEntries(JOBS.map(job => [job.name, NOW]));
  let jobs = 0;
  const lines = [];
  const info = console.info;
  console.info = line => lines.push(String(line));
  try {
    const first = await runDurableAlarmTurn({
      db, env, store: null, now: NOW, lastRan, includeSlow: true, drain: true,
      runJob: async () => { jobs += 1; return [{ ok: true }]; }
    });
    assert.equal(jobs, 0);
    assert.equal(first.ran, true);
    assert.equal(first.item.kind, "history-census");
    const second = await runDurableAlarmTurn({
      db, env, store: null, now: NOW + 1, lastRan, includeSlow: true, drain: true,
      runJob: async () => { jobs += 1; return [{ ok: true }]; }
    });
    assert.equal(jobs, 0);
    assert.equal(second.item.kind, "history-census");
  } finally {
    console.info = info;
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM room_history_census").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM durable_alarm_queue").get().n, 1);
  assert.equal(lines.some(line => line.includes("commons") || line.includes("muse")), false);
  assert.ok(lines.some(line => line.includes("room.history_census")));
  const summary = historyCensusSummary(db);
  assert.equal(summary.rooms, 2);
  assert.equal(summary.roomsAtCap, 0);
});
