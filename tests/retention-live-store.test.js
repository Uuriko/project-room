import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runLiveStoreRetention } from "../server/retention-run.mjs";

const NOW = "2026-09-25T12:00:00.000Z", clock = Date.parse(NOW), day = 86400000;
const inserters = {
  web_fetch_log: (store, id, at) => store.db.prepare("INSERT INTO web_fetch_log(request_id,room_id,member_id,credential_hash,host,cache_status,bytes,tags_json,created_at) VALUES(?,?,?,?,'example.com','hit',2,'[]',?)").run(id, "commons", "owner", null, at),
  web_research_log: (store, id, at) => store.db.prepare("INSERT INTO web_research_log(request_id,room_id,member_id,credential_hash,question_hash,sources_json,evidence_count,plan_only,created_at) VALUES(?,?,?,?,'hash','[]',0,1,?)").run(id, "commons", "owner", null, at)
};
const seed = (store, table, prefix, count, at) => store.transaction(() => {
  for (let n = 0; n < count; n++) inserters[table](store, `${prefix}-${n}`, at);
});
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), "room-live-retention-"));
  const store = new RoomStore(join(dir, "room.sqlite")); store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const table of ["web_fetch_log", "web_research_log"]) {
    seed(store, table, `${table}-old`, 3, clock - 35 * day);
    inserters[table](store, `${table}-new`, clock - 2 * day);
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

test("every disposable log drains on the same tick and protected rows are left alone", t => {
  const store = fixture(t);
  const kept = protect(store);
  const run = runLiveStoreRetention({ store, now: NOW });
  assert.equal(run.dryRun, false);
  assert.deepEqual(run.tables, ["web_fetch_log", "web_research_log"]);
  assert.equal(run.deleted, 6);
  for (const table of run.tables) {
    assert.equal(run.categories[table].eligible, 3, `${table} eligible`);
    assert.equal(run.categories[table].deleted, 3, `${table} deleted`);
    assert.equal(run.categories[table].moreMayRemain, false, `${table} drained`);
    assert.equal(count(store, table), 1, `${table} keeps only the fresh row`);
  }
  assert.equal(count(store, "events"), kept.events);
  assert.equal(count(store, "activity_events"), kept.unread);
  assert.equal(store.db.prepare("SELECT read_at FROM activity_events").get().read_at, null);
  assert.equal(count(store, "agent_webhook_deliveries"), kept.pending);
  assert.equal(store.db.prepare("SELECT state FROM agent_webhook_deliveries").get().state, "pending");
});

test("the receipt records a disposition for each historically excluded table", t => {
  const store = fixture(t);
  const run = runLiveStoreRetention({ store, now: NOW });
  const byTable = Object.fromEntries(run.excluded.map(entry => [entry.table, entry]));
  assert.deepEqual(Object.keys(byTable).sort(), [
    "account_access_events", "activity_events", "agent_webhook_deliveries",
    "commands", "events", "membership_invitation_events"
  ]);
  assert.equal(byTable.events.disposition, "keep");
  assert.equal(byTable.account_access_events.disposition, "keep");
  assert.equal(byTable.agent_webhook_deliveries.disposition, "drain");
  for (const entry of run.excluded) {
    assert.ok(entry.reason.trim().length >= 40, `${entry.table} carries its recorded reason`);
  }
});

// HUNT-SOAK S-4 acceptance shape: the pre-fix tick deleted exactly 100 rows
// per table-visit (5,000 seeded -> 4,500 after 5 visits). One tick must now
// drain the whole eligible backlog per table, in batches, or report its
// budget exhaustion.
test("a 5,000-row backlog per table drains in one tick, in batches", t => {
  const store = fixture(t);
  for (const table of ["web_fetch_log", "web_research_log"]) seed(store, table, `${table}-bulk`, 5000, clock - 40 * day);
  const run = runLiveStoreRetention({ store, now: NOW, deadline: Date.now() + 120000 });
  assert.equal(run.budgetExceeded, false);
  for (const table of run.tables) {
    // 5,000 bulk rows + the fixture's 3 old rows; the fresh row survives.
    assert.equal(run.categories[table].eligible, 5003, `${table} eligible`);
    assert.equal(run.categories[table].deleted, 5003, `${table} deleted`);
    assert.ok(run.categories[table].batches >= 10, `${table} drained in batches, not one unbounded delete`);
    assert.equal(run.categories[table].moreMayRemain, false);
    assert.equal(count(store, table), 1);
  }
});

test("the batch limit is a transaction size, not a per-tick ceiling", t => {
  const store = fixture(t);
  const run = runLiveStoreRetention({ store, now: NOW, limit: 2 });
  assert.equal(run.categories.web_fetch_log.deleted, 3);
  assert.equal(run.categories.web_fetch_log.batches, 2);
  assert.equal(count(store, "web_fetch_log"), 1);
  assert.equal(runLiveStoreRetention({ store, now: NOW }).deleted, 0);
});

test("steady state: the next arrival wave drains on the next tick and the table holds flat", t => {
  const store = fixture(t);
  runLiveStoreRetention({ store, now: NOW });
  seed(store, "web_fetch_log", "fetch-wave2", 3, clock - 35 * day);
  const second = runLiveStoreRetention({ store, now: NOW });
  assert.equal(second.categories.web_fetch_log.deleted, 3);
  assert.equal(second.categories.web_research_log.deleted, 0);
  assert.equal(count(store, "web_fetch_log"), 1);
  assert.equal(count(store, "web_research_log"), 1);
});

test("an operator zero flag plans every table and deletes nothing", t => {
  const store = fixture(t);
  const receipt = runLiveStoreRetention({ store, env: { ROOM_RETENTION_ALLOW_DELETION: "0" }, now: NOW });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.categories.web_fetch_log.eligible, 3);
  assert.equal(receipt.categories.web_research_log.eligible, 3);
  assert.equal(count(store, "web_fetch_log"), 4);
  assert.equal(count(store, "web_research_log"), 4);
});

// Budget exhaustion leaves consistent state: nothing is deleted past the
// deadline, the deleted rows are exactly the oldest eligible prefix, and
// the receipt says more remains in both tables.
test("a passed deadline stops the drain and reports the backlog honestly", t => {
  const store = fixture(t);
  const receipt = runLiveStoreRetention({ store, now: NOW, deadline: 0 });
  assert.equal(receipt.budgetExceeded, true);
  assert.equal(receipt.deleted, 0);
  for (const table of receipt.tables) {
    assert.equal(receipt.categories[table].moreMayRemain, true, `${table} reports its remainder`);
    assert.equal(receipt.categories[table].deleted, 0);
    assert.equal(count(store, table), 4);
  }
});

test("invalid clock and batch size refuse destructive work", t => {
  const store = fixture(t), env = { ROOM_RETENTION_ALLOW_DELETION: "1" };
  for (const input of [{ now: "no-date" }, { limit: 100000 }, { limit: 501 }, { limit: 0 }]) {
    assert.throws(() => runLiveStoreRetention({ store, env, ...input }), /retention/);
    assert.equal(count(store, "web_fetch_log"), 4);
  }
});
