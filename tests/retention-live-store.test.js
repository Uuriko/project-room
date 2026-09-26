import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runLiveStoreRetention } from "../server/retention-run.mjs";

const NOW = "2026-09-25T12:00:00.000Z", clock = Date.parse(NOW), day = 86400000;
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), "room-live-retention-"));
  const store = new RoomStore(join(dir, "room.sqlite")); store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const table of ["web_fetch_log", "web_research_log"]) {
    const common = ["commons", "owner", null, clock - 35 * day];
    const insert = table === "web_fetch_log"
      ? (id, at) => store.db.prepare("INSERT INTO web_fetch_log(request_id,room_id,member_id,credential_hash,host,cache_status,bytes,tags_json,created_at) VALUES(?,?,?,?,'example.com','hit',2,'[]',?)").run(id, common[0],common[1],common[2],at)
      : (id, at) => store.db.prepare("INSERT INTO web_research_log(request_id,room_id,member_id,credential_hash,question_hash,sources_json,evidence_count,plan_only,created_at) VALUES(?,?,?,?,'hash','[]',0,1,?)").run(id, common[0],common[1],common[2],at);
    for (let n = 0; n < 3; n++) insert(table + "-old-" + n, clock - (35 + n) * day);
    insert(table + "-new", clock - 2 * day);
  }
  return store;
};
const count = (store, table) => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test("store retention is dry-run by default and cannot touch room journals", t => {
  const store = fixture(t); const events = count(store, "events");
  const receipt = runLiveStoreRetention({ store, now: NOW });
  assert.equal(receipt.liveStoreScanned, true); assert.equal(receipt.dryRun, true);
  assert.equal(receipt.deleted, 0); assert.equal(receipt.categories.web_fetch_log.eligible, 3);
  assert.equal(count(store, "web_fetch_log"), 4); assert.equal(count(store, "events"), events);
});

test("opt-in batches delete expired disposable log rows only and reruns are safe", t => {
  const store = fixture(t), env = { ROOM_RETENTION_ALLOW_DELETION: "1" };
  const first = runLiveStoreRetention({ store, env, now: NOW, limit: 2 });
  assert.equal(first.deleted, 4); assert.equal(first.categories.web_fetch_log.moreMayRemain, true);
  const second = runLiveStoreRetention({ store, env, now: NOW, limit: 2 });
  assert.equal(second.deleted, 2);
  assert.equal(runLiveStoreRetention({ store, env, now: NOW }).deleted, 0);
  assert.equal(count(store, "web_fetch_log"), 1);
  assert.equal(count(store, "web_research_log"), 1);
  assert.ok(count(store, "events") > 0);
});

test("invalid clock and batch size refuse destructive work", t => {
  const store = fixture(t), env = { ROOM_RETENTION_ALLOW_DELETION: "1" };
  for (const input of [{ now: "no-date" }, { limit: 100000 }, { limit: 0 }]) {
    assert.throws(() => runLiveStoreRetention({ store, env, ...input }), /retention/);
    assert.equal(count(store, "web_fetch_log"), 4);
  }
});
