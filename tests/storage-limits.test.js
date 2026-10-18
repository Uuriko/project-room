import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { searchValueLimit, sqliteValueLimit } from "../server/storage-limits.mjs";

// r56: /api/version reports the largest value the store's SQLite accepts, read
// with `SELECT length(zeroblob(?))` (no table, no row, no write). Under workerd
// the answer is the Durable Object row limit of the runtime build Cloudflare
// runs: 2,200,000 on workerd 1.20260730.1 (the repo pin), 8,388,642
// (8 MiB + 34 B) on 1.20261018.1, measured in Miniflare by research r56.

const tooBig = () => Object.assign(new Error("string or blob too big: SQLITE_TOOBIG"), { code: "ERR_SQLITE_ERROR" });
// What cloudflare/storage.mjs DurableDatabase throws in place of SQLITE_TOOBIG.
const pilotLimit = () => Object.assign(new Error("Room storage limit reached (platform row limit); no data was changed"), { status: 409, code: "pilot_limit" });

function fakeDb(limit, refuse = tooBig) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      assert.equal(sql, "SELECT length(zeroblob(?)) AS n");
      return { get(bytes) { calls.push(bytes); if (bytes > limit) throw refuse(); return { n: bytes }; } };
    }
  };
}

test("the search finds each known runtime limit exactly, in at most 32 reads", () => {
  for (const limit of [2_200_000, 4 * 1024 * 1024, 8 * 1024 * 1024 + 34, 1_000_000_000]) {
    const db = fakeDb(limit);
    assert.deepEqual(sqliteValueLimit(db), { valueLimitBytes: limit });
    assert.ok(db.calls.length <= 32, `${db.calls.length} reads for ${limit}`);
  }
});

test("the Durable Object adapter's pilot_limit refusal counts as too big", () => {
  assert.deepEqual(sqliteValueLimit(fakeDb(8 * 1024 * 1024 + 34, pilotLimit)), { valueLimitBytes: 8_388_642 });
});

test("any other error makes the answer unknown (null), never a guessed number", () => {
  const db = { prepare: () => ({ get: bytes => { if (bytes > 5000) throw new Error("not authorized to use function: zeroblob"); return { n: bytes }; } }) };
  assert.equal(sqliteValueLimit(db), null);
  assert.equal(sqliteValueLimit({ prepare() { throw new Error("no such function"); } }), null);
  assert.equal(sqliteValueLimit(null), null);
  assert.deepEqual(searchValueLimit(() => true, { max: 64 }), { valueLimitBytes: null, atLeastBytes: 64 });
});

test("the answer is memoized per database handle", () => {
  const db = fakeDb(2_200_000);
  sqliteValueLimit(db);
  const first = db.calls.length;
  sqliteValueLimit(db);
  assert.equal(db.calls.length, first);
});

test("real SQLite: the default limit is read and nothing is written", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(sqliteValueLimit(db), { valueLimitBytes: 1_000_000_000 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n, 0);
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, 0);
  } finally { db.close(); }
});

test("GET /api/version carries storage.valueLimitBytes; HEAD stays empty", async t => {
  const directory = mkdtempSync(join(tmpdir(), "r56-storage-limits-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const version = await (await fetch(origin + "/api/version")).json();
  assert.equal(version.status, "ok");
  assert.deepEqual(version.storage, { valueLimitBytes: 1_000_000_000 });
  const head = await fetch(origin + "/api/version", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
