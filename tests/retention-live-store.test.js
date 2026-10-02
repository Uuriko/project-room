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

function protect(store) {
  store.db.prepare(`INSERT INTO activity_events(room_id,type,actor_id,actor_name,message_id,thread_id,user_id,created_at,read_at)
    VALUES('commons','mention','owner','Owner','unread-msg','', 'owner', ?, NULL)`).run(clock - 400 * day);
  store.db.prepare(`INSERT INTO agent_webhook_deliveries(
      delivery_id,idempotency_key,subscription_id,agent_id,event_type,payload_json,signature,state,attempts,next_attempt_at,created_at,updated_at)
    VALUES('pending-old','pending-old','sub','agent','message.posted','{}','sig','pending',0,?, ?, ?)`).run(clock, clock - 400 * day, clock);
  return { events: count(store, "events"), unread: count(store, "activity_events"), pending: count(store, "agent_webhook_deliveries") };
}

test("each disposable log applies its own age policy and leaves protected rows", t => {
  const store = fixture(t);
  const kept = protect(store);
  const fetchRun = runLiveStoreRetention({ store, now: NOW, tableIndex: 0 });
  assert.equal(fetchRun.dryRun, false);
  assert.equal(fetchRun.table, "web_fetch_log");
  assert.equal(fetchRun.deleted, 3);
  assert.equal(fetchRun.categories.web_fetch_log.eligible, 3);
  assert.equal(count(store, "web_fetch_log"), 1);
  assert.equal(count(store, "web_research_log"), 4);
  const researchRun = runLiveStoreRetention({ store, now: NOW, tableIndex: 1 });
  assert.equal(researchRun.table, "web_research_log");
  assert.equal(researchRun.deleted, 3);
  assert.equal(count(store, "web_research_log"), 1);
  assert.equal(count(store, "web_fetch_log"), 1);
  assert.equal(count(store, "events"), kept.events);
  assert.equal(count(store, "activity_events"), kept.unread);
  assert.equal(store.db.prepare("SELECT read_at FROM activity_events").get().read_at, null);
  assert.equal(count(store, "agent_webhook_deliveries"), kept.pending);
  assert.equal(store.db.prepare("SELECT state FROM agent_webhook_deliveries").get().state, "pending");
});

test("a batch stays inside the limit and a later tick finishes the same table", t => {
  const store = fixture(t);
  const first = runLiveStoreRetention({ store, now: NOW, tableIndex: 0, limit: 2 });
  assert.equal(first.deleted, 2);
  assert.equal(first.categories.web_fetch_log.moreMayRemain, true);
  assert.equal(count(store, "web_research_log"), 4);
  const second = runLiveStoreRetention({ store, now: NOW, tableIndex: 0, limit: 2 });
  assert.equal(second.deleted, 1);
  assert.equal(count(store, "web_fetch_log"), 1);
  assert.equal(runLiveStoreRetention({ store, now: NOW, tableIndex: 0 }).deleted, 0);
});

test("an operator zero flag plans the table and deletes nothing", t => {
  const store = fixture(t);
  const receipt = runLiveStoreRetention({ store, env: { ROOM_RETENTION_ALLOW_DELETION: "0" }, now: NOW, tableIndex: 0 });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.categories.web_fetch_log.eligible, 3);
  assert.equal(count(store, "web_fetch_log"), 4);
});

test("a passed deadline stops the delete batch", t => {
  const store = fixture(t);
  const receipt = runLiveStoreRetention({ store, now: NOW, tableIndex: 0, deadline: 0 });
  assert.equal(receipt.budgetExceeded, true);
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.categories.web_fetch_log.moreMayRemain, true);
  assert.equal(count(store, "web_fetch_log"), 4);
});

test("invalid clock and batch size refuse destructive work", t => {
  const store = fixture(t), env = { ROOM_RETENTION_ALLOW_DELETION: "1" };
  for (const input of [{ now: "no-date" }, { limit: 100000 }, { limit: 0 }]) {
    assert.throws(() => runLiveStoreRetention({ store, env, ...input }), /retention/);
    assert.equal(count(store, "web_fetch_log"), 4);
  }
});
