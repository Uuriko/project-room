// Storage alerts: the 8 GB line under the 10 GB database cap is named even
// when a room breach is also present, and each room warns at 3.5 MiB under
// the 4 MiB store cap (counted in the job summary, flagged on the room's
// usage card).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableDatabase } from "../cloudflare/storage.mjs";
import { STORAGE_ALERT_LINES, jobByName, measureStoreGrowth, storageAlerts } from "../server/jobs.mjs";
import { ROOM_STORE_WARN_BYTES, roomUsageSummary } from "../server/usage-summary.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function durable(databaseSize, projections) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL)");
  projections.forEach((bytes, i) => db.prepare("INSERT INTO rooms VALUES (?, ?, ?)").run(`r${i}`, 1, "x".repeat(bytes)));
  const sql = {
    exec(query, ...args) {
      if (/^\s*PRAGMA/i.test(query)) throw new Error("not authorized: SQLITE_AUTH");
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows, one: () => rows[0], rowsRead: rows.length };
    }
  };
  Object.defineProperty(sql, "databaseSize", { get: () => databaseSize });
  return { db: new DurableDatabase({ sql }) };
}

test("the lines sit under the caps they guard", () => {
  assert.equal(STORAGE_ALERT_LINES.dbBytes, 8_000_000_000);
  assert.equal(STORAGE_ALERT_LINES.dbCapBytes, 10_000_000_000);
  assert.equal(STORAGE_ALERT_LINES.roomWarnBytes, 3.5 * 1024 * 1024);
  assert.equal(ROOM_STORE_WARN_BYTES, STORAGE_ALERT_LINES.roomWarnBytes);
});

test("a quiet store raises nothing and the tick passes", async () => {
  const store = durable(1_000_000, [1000, 2000]);
  const summary = await jobByName("store-growth").run(store);
  assert.equal(summary.errors, undefined);
  assert.equal(summary.roomsNearCap, 0);
  assert.equal(summary.alerts, undefined);
});

test("a database at 8 GB fails the tick with db_near_cap", async () => {
  const summary = await jobByName("store-growth").run(durable(8_000_000_000, [1000]));
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.alerts, ["db_near_cap"]);
  assert.equal(summary.failureDetail.subcheck, "db_near_cap");
});

test("failing first: the database line is named even behind a room breach", async () => {
  const summary = await jobByName("store-growth").run(durable(9_000_000_000, [3_700_000]));
  assert.deepEqual(summary.alerts, ["db_near_cap", "room_near_store_cap"]);
  assert.equal(summary.failureDetail.subcheck, "db_near_cap");
});

test("rooms past 3.5 MiB are counted without ids", async () => {
  const lines = STORAGE_ALERT_LINES.roomWarnBytes;
  const gauges = measureStoreGrowth(durable(1, [lines - 1, lines, lines + 10]));
  assert.equal(gauges.roomsNearCap, 2);
  assert.deepEqual(storageAlerts(gauges), ["room_near_store_cap"]);
  const summary = await jobByName("store-growth").run(durable(1, [lines + 10]));
  assert.equal(JSON.stringify(summary).includes("r0"), false);
});

test("the room usage card flags room size at 3.5 MiB", t => {
  const directory = mkdtempSync(join(tmpdir(), "storage-alerts-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const token = owner?.token ?? owner;
  const card = () => roomUsageSummary(store, token, "commons").caps.projectionBytes;
  assert.equal(card().warning, false);
  const pad = (bytes) => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n < bytes;
  assert.ok(pad(ROOM_STORE_WARN_BYTES));
  store.db.prepare("UPDATE rooms SET projection = json_set(projection, '$.fixturePad', ?) WHERE id='commons'").run("x".repeat(ROOM_STORE_WARN_BYTES));
  assert.equal(card().warning, true);
  assert.ok(card().used >= ROOM_STORE_WARN_BYTES);
});

test("room_usage returns the same projection warning as the usage card", async t => {
  const directory = mkdtempSync(join(tmpdir(), "storage-alerts-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.identities.create("Ada");
  const created = new AgentRooms(store).create(owner.secret, { title: "Usage", purpose: "usage warning", displayName: "Ada" });
  const mcp = createHostedRoomMcp(store);
  const call = days => mcp(
    { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name: "room_usage", arguments: { roomId: created.roomId, ...(days === undefined ? {} : { days }) } } },
    { authorization: `Bearer ${owner.secret}` }
  );
  const valueOf = response => {
    assert.equal(response.error, undefined);
    return response.result.structuredContent;
  };
  assert.equal(valueOf(await call()).caps.projectionBytes.warning, false);
  store.db.prepare("UPDATE rooms SET projection = json_set(projection, '$.fixturePad', ?) WHERE id=?").run("x".repeat(ROOM_STORE_WARN_BYTES), created.roomId);
  const warned = valueOf(await call(7));
  assert.equal(warned.caps.projectionBytes.warning, true);
  assert.equal(warned.period.days, 7);
});
