// The Worker's room database rejects a statement with more than 100 bound
// values; Node's SQLite allows 32766, which is how the r38 patrol look-back
// and the r39 restore look-up passed the Node suite and failed on prod.
// ROOM_SQL_BIND_LIMIT=100 makes a Node store enforce the Worker's limit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, nodeSqlLimits } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream } from "../server/room-export.mjs";
import { operatorRestoreFromBackupResponse } from "../server/restore-ndjson.mjs";
import { writeKvBackup } from "../cloudflare/room-backup.mjs";

const binds = (db, n) => db.prepare(`SELECT ? IN (${Array(n).fill("?").join(",")}) AS x`).get(...Array(n + 1).fill(1)).x;

function withLimit(t, value) {
  const before = process.env.ROOM_SQL_BIND_LIMIT;
  if (value === undefined) delete process.env.ROOM_SQL_BIND_LIMIT; else process.env.ROOM_SQL_BIND_LIMIT = value;
  t.after(() => { if (before === undefined) delete process.env.ROOM_SQL_BIND_LIMIT; else process.env.ROOM_SQL_BIND_LIMIT = before; });
}

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("nodeSqlLimits reads ROOM_SQL_BIND_LIMIT and ignores anything that is not a positive integer", () => {
  assert.deepEqual(nodeSqlLimits({ ROOM_SQL_BIND_LIMIT: "100" }), { limits: { variableNumber: 100 } });
  for (const value of [undefined, "", "0", "-5", "abc", "99.5"]) assert.deepEqual(nodeSqlLimits({ ROOM_SQL_BIND_LIMIT: value }), {}, String(value));
});

test("with ROOM_SQL_BIND_LIMIT=100 a Node store rejects 101 values with the Worker's own error", t => {
  withLimit(t, "100");
  const store = openStore(t, "bind-guard-on-");
  assert.equal(binds(store.db, 99), 1); // 100 values
  assert.throws(() => binds(store.db, 100), /too many SQL variables/); // 101 values
});

test("without the guard Node's SQLite takes far more than the Worker does (why the suite missed these)", t => {
  withLimit(t, undefined);
  const store = openStore(t, "bind-guard-off-");
  assert.equal(binds(store.db, 500), 1);
});

function fakeKv() {
  const map = new Map();
  return { async get(key) { return map.has(key) ? map.get(key) : null; }, async put(key, value) { map.set(key, typeof value === "string" ? value : Buffer.from(value)); }, async delete(key) { map.delete(key); } };
}

// Lands as a todo: on main the restore look-up binds every distinct parent
// key at once, so this fails under the guard until the bind-limit fix
// (research-r40-do-bind-limits) lands; then drop the todo.
test("under the guard, restore-from-backup survives 101 browser sessions with distinct parent keys", { todo: "passes once the restore look-up is chunked (research-r40-do-bind-limits)" }, async t => {
  withLimit(t, "100");
  const seed = openStore(t, "bind-guard-seed-");
  seed.initialize(initialRoom());
  for (let i = 0; i < 101; i++) seed.createSession(seed.issueAccessKey("commons", "owner"));
  const kv = fakeKv(), key = "room-backups/2026-10-17.ndjson", token = "bind-guard-operator-token-0123456789abcdef";
  await writeKvBackup(kv, key, exportNdjsonStream(seed.db), { partBytes: 16384 });
  const target = openStore(t, "bind-guard-target-");
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const response = await operatorRestoreFromBackupResponse({ method: "POST", url: `https://room.example/api/operator/restore-from-backup?key=${encodeURIComponent(key)}`, headers, text: async () => "" }, token, target, kv);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM credentials WHERE parent_hash IS NOT NULL").get().n, 101);
});
