// H3 privacy audit (2026-10-07): account deletion must purge the remaining
// account-keyed channel/inbox tables that SEC-04 (Fo, 2026-10-05) missed.
//
// SEC-04 added the derived_inbox category for inbox_handoffs,
// sla_breach_alerts, pending_channel_updates, and telegram_live_status, but
// three more tables that server/purge-registry.mjs marks `delete` for the
// account scope still survive self-serve account deletion:
//   - direct_channel_sends (the account's direct gmail/telegram send journal)
//   - quarantine_thread_splits (quarantine review actions by the account)
//   - spam_quarantine (messages quarantined for the account)
//
// The test fails on the pre-fix code (rows survive) and passes once the
// tables join DERIVED_INBOX_TABLES. The FK-abort half of SEC-04 is already
// covered by tests/account-deletion-residual-sec04.test.js and is not
// re-tested here.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  planAccountDeletion,
  executeAccountDeletion,
  inventoryFromStore,
  RETENTION_POLICY,
} from "../server/account-deletion.mjs";

const REMAINING = ["direct_channel_sends", "quarantine_thread_splits", "spam_quarantine"];

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => Date.now() });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const A = "u-h3-gap";
  store.db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,'test',?)")
    .run(A, Date.now());
  return { store, A };
}

function seed(store, A) {
  const db = store.db;
  db.prepare("INSERT INTO direct_channel_sends(id,account_id,channel,recipient,body_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("dcs1", A, "email", "r@example.com", "hash", "sent", 1, 1);
  db.prepare("INSERT INTO quarantine_thread_splits(quarantine_id,account_id,source_id,prior_thread,reviewer,split_at) VALUES(?,?,?,?,?,?)")
    .run("q1", A, "s1", "pt", "rv", 1);
  db.prepare("INSERT INTO spam_quarantine(id,message_id,channel,account_id,reason,score,quarantined_at,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("sq1", "m1", "email", A, "{}", 90, 1, "held", 1);
}

const count = (store, table, A) => store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(A).n;

test("account deletion purges direct sends, quarantine splits, and spam quarantine rows", t => {
  const { store, A } = setup(t);
  seed(store, A);
  assert.equal(inventoryFromStore(store, A).derived_inbox.itemCount, 3);
  executeAccountDeletion(store, planAccountDeletion(store, A).plan);
  for (const table of REMAINING) {
    assert.equal(count(store, table, A), 0, `${table} rows survive account deletion`);
  }
});

test("retention policy names the newly purged tables", () => {
  const entry = RETENTION_POLICY.purged.find(row => row.category === "derived_inbox");
  assert.ok(entry, "derived_inbox is a disclosed purged category");
  for (const table of REMAINING) {
    assert.match(entry.description, new RegExp(table), `policy names ${table}`);
  }
});
