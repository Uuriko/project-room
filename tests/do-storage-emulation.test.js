// TST-12: run RoomStore and the HTTP server on a Durable Object-like store in
// Node, and hold the DO-only rules (no SQL transaction statements, nested
// transactionSync, ArrayBuffer blobs, strict one()) so DO-only bugs fail here
// before they reach workerd.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import { createDoContext, DoStorageError, DoStorageEmulator } from "./helpers/do-storage-emulator.mjs";

const ROOM = "commons";
// Fixed clock so both stores stamp identical times (TST-11 helper not on main yet).
const createTestClock = (start = Date.now()) => { const at = start; return { now: () => at }; };
const command = (type, data) => ({ id: randomUUID(), type, data });

function doStore(t, clock) {
  const ctx = createDoContext();
  const store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage, now: clock.now });
  store.initialize(initialRoom());
  t.after(() => { store.close(); ctx.storage.close(); });
  return { store, storage: ctx.storage };
}

function nodeStore(t, clock) {
  const directory = mkdtempSync(join(tmpdir(), "room-do-parity-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: clock.now });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store };
}

// One scripted session: owner posts, adds an agent, the agent posts a reply.
function script(store) {
  const owner = store.issueAccessKey(ROOM, "owner");
  store.command(owner, ROOM, command(T.MESSAGE_POSTED, { messageId: "m-1", body: "hello from the owner" }));
  store.command(owner, ROOM, command(T.MEMBER_ADDED, { memberId: "bot", displayName: "Bot", kind: "agent", accountableHumanId: "owner", permissions: [] }));
  const bot = store.issueAccessKey(ROOM, "bot");
  store.command(bot, ROOM, command(T.MESSAGE_POSTED, { messageId: "m-2", body: "hello back", replyToId: "m-1" }));
  return { owner, bot };
}

const projection = store => {
  const { state, sequence } = store.room(ROOM);
  return { sequence, members: Object.keys(state.members).sort(), messages: state.messages.map(m => [m.id ?? m.messageId, m.body, m.from ?? m.authorId]) };
};

test("TST-12: RoomStore initializes and writes on the DO emulator", t => {
  const clock = createTestClock(Date.UTC(2026, 9, 9, 12));
  const { store, storage } = doStore(t, clock);
  script(store);
  assert.ok(store.room(ROOM).sequence > 2);
  assert.ok(storage.stats.transactions > 0, "writes went through transactionSync");
  assert.equal(storage.stats.rejected, 0, "the store never sent a statement DO refuses");
});

test("TST-12: DO and node:sqlite stores give the same projection for the same commands", t => {
  const clockA = createTestClock(Date.UTC(2026, 9, 9, 12));
  const clockB = createTestClock(Date.UTC(2026, 9, 9, 12));
  const durable = doStore(t, clockA).store;
  const local = nodeStore(t, clockB).store;
  script(durable);
  script(local);
  assert.deepEqual(projection(durable), projection(local));
});

test("TST-12: the HTTP server serves a DO-backed store", async t => {
  const clock = createTestClock();
  const { store, storage } = doStore(t, clock);
  const { owner } = script(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/api/rooms/${ROOM}`, { headers: { Origin: origin, Authorization: `Bearer ${owner}` } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /hello from the owner/);
  assert.match(text, /hello back/);
  assert.equal(storage.stats.rejected, 0);
});

test("TST-12: the emulator refuses SQL transaction statements like DO does", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  const refuseTransactions = () => {
    for (const prefix of ["", "/* comment */ ", "-- comment\n", "; ", "; /* comment */ ", ";; -- comment\n; "]) {
      for (const sql of ["BEGIN", "BEGIN IMMEDIATE", "COMMIT", "END", "ROLLBACK", "ROLLBACK TO a", "SAVEPOINT a", "RELEASE a", "  begin transaction"]) {
        const rejected = storage.stats.rejected;
        assert.throws(() => storage.sql.exec(prefix + sql), { name: "DoStorageError", message: /use transactionSync/ }, prefix + sql);
        assert.equal(storage.stats.rejected, rejected + 1);
      }
    }
  };
  refuseTransactions();
  storage.sql.exec("CREATE TABLE guarded(v INTEGER)");
  storage.transactionSync(() => {
    storage.sql.exec("INSERT INTO guarded VALUES (1)");
    refuseTransactions();
    storage.transactionSync(() => { refuseTransactions(); storage.sql.exec("INSERT INTO guarded VALUES (2)"); });
    refuseTransactions();
  });
  refuseTransactions();
  assert.deepEqual(storage.sql.exec("SELECT v FROM guarded ORDER BY v").toArray(), [{ v: 1 }, { v: 2 }]);
  assert.throws(() => storage.sql.exec("SELECT ?", undefined), DoStorageError);
  assert.throws(() => storage.sql.exec("SELECT ?", { a: 1 }), DoStorageError);
});

test("TST-12: nested transactionSync rolls back only the inner work", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  storage.sql.exec("CREATE TABLE k (v TEXT)");
  storage.transactionSync(() => {
    storage.sql.exec("INSERT INTO k VALUES (?)", "outer");
    assert.throws(() => storage.transactionSync(() => { storage.sql.exec("INSERT INTO k VALUES (?)", "inner"); throw new Error("boom"); }), /boom/);
  });
  assert.deepEqual(storage.sql.exec("SELECT v FROM k").toArray(), [{ v: "outer" }]);
  assert.throws(() => storage.transactionSync(() => { storage.sql.exec("INSERT INTO k VALUES ('x')"); throw new Error("all"); }), /all/);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM k").one().n, 1, "outer rollback drops everything");
  assert.throws(() => storage.transactionSync(async () => {}), /synchronous/);
  assert.equal(storage.sql.exec("SELECT COUNT(*) AS n FROM k").one().n, 1);
});

test("TST-12: cursors follow the DO shape", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  storage.sql.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)");
  const write = storage.sql.exec("INSERT INTO b(data) VALUES (?)", new Uint8Array([1, 2, 3]).buffer);
  assert.equal(write.rowsWritten, 1);
  const cursor = storage.sql.exec("SELECT id, data FROM b");
  assert.deepEqual(cursor.columnNames, ["id", "data"]);
  const row = cursor.one();
  assert.ok(row.data instanceof ArrayBuffer, "blobs come back as ArrayBuffer");
  assert.deepEqual([...new Uint8Array(row.data)], [1, 2, 3]);
  // one() consumed the cursor; raw() on a fresh cursor gives the row as an array.
  assert.deepEqual([...cursor.raw()], []);
  assert.deepEqual([...storage.sql.exec("SELECT id, data FROM b").raw()][0][0], 1);
  assert.throws(() => storage.sql.exec("SELECT id FROM b WHERE id = 99").one(), /no results/);
  storage.sql.exec("INSERT INTO b(data) VALUES (NULL)");
  assert.throws(() => storage.sql.exec("SELECT id FROM b").one(), /multiple results/);
  assert.equal(storage.sql.exec("PRAGMA foreign_keys").one().foreign_keys, 1);
});

test("TST-12 review: cursors are single-pass and share one position", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  storage.sql.exec("CREATE TABLE r(n INTEGER)");
  storage.sql.exec("INSERT INTO r VALUES (1),(2),(3)");
  const cursor = storage.sql.exec("SELECT n FROM r ORDER BY n");
  assert.equal(typeof cursor.next, "function");
  assert.deepEqual(cursor.next(), { done: false, value: { n: 1 } });
  assert.deepEqual([...cursor.raw()], [[2], [3]]);
  assert.deepEqual(cursor.toArray(), []);
  assert.equal(cursor.next().done, true);
  const again = storage.sql.exec("SELECT n FROM r ORDER BY n");
  assert.equal(again.toArray().length, 3);
  assert.deepEqual(again.toArray(), []);
});

test("TST-12 review: a ';' inside a string does not split, and multi-statement SELECT returns the last cursor", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  storage.sql.exec("CREATE TABLE s(v TEXT)");
  storage.sql.exec("INSERT INTO s VALUES ('a;b')");
  assert.deepEqual(storage.sql.exec("SELECT v FROM s WHERE v = 'a;b'").toArray(), [{ v: "a;b" }]);
  assert.deepEqual(storage.sql.exec("SELECT 1 AS x; SELECT 2 AS y").toArray(), [{ y: 2 }]);
  storage.sql.exec("CREATE TRIGGER s_t AFTER INSERT ON s BEGIN UPDATE s SET v = v || ';' WHERE rowid = NEW.rowid; END; INSERT INTO s VALUES ('c')");
  assert.deepEqual(storage.sql.exec("SELECT v FROM s ORDER BY rowid").toArray().map(r => r.v), ["a;b", "c;"]);
});

test("TST-12 review: a deferred foreign-key failure at COMMIT leaves depth at 0", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  storage.sql.exec("CREATE TABLE p(id INTEGER PRIMARY KEY)");
  storage.sql.exec("CREATE TABLE c(pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)");
  assert.throws(() => storage.transactionSync(() => { storage.sql.exec("INSERT INTO c VALUES (99)"); }));
  assert.equal(storage.depth, 0);
  assert.throws(() => storage.sql.exec("; BEGIN"), DoStorageError);
  storage.transactionSync(() => { storage.sql.exec("INSERT INTO p VALUES (1)"); storage.transactionSync(() => storage.sql.exec("INSERT INTO c VALUES (1)")); });
  assert.equal(storage.depth, 0);
  assert.equal(storage.sql.exec("SELECT count(*) AS n FROM c").one().n, 1);
});

test("TST-12 review: a CASE ... END inside a trigger body does not end the trigger", t => {
  const storage = new DoStorageEmulator();
  t.after(() => storage.close());
  storage.sql.exec("CREATE TABLE g(v INTEGER); CREATE TRIGGER g_t BEFORE INSERT ON g BEGIN SELECT CASE WHEN NEW.v < 0 THEN RAISE(ABORT,'negative; no') END; END; INSERT INTO g VALUES (1)");
  assert.throws(() => storage.sql.exec("INSERT INTO g VALUES (-1)"), /negative; no/);
  assert.equal(storage.sql.exec("SELECT count(*) AS n FROM g").one().n, 1);
});
