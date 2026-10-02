import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { derivedSources, readDerivedPage } from "../server/analytics/derive-tables.mjs";
import { dailyValue, ensureAnalyticsSchema } from "../server/analytics/schema.mjs";
import { runAnalyticsTail } from "../server/analytics/tail.mjs";

test("side-table readers page by created time and id, and a missing table is counted", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE share_links (id TEXT PRIMARY KEY, room_id TEXT, issuer_member_id TEXT, created_at INTEGER)`);
  db.exec(`INSERT INTO share_links VALUES('b','alpha','owner', 20), ('a','alpha','owner', 10)`);
  const first = readDerivedPage(db, "share_links", null, 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].props.invite_kind, "share_link");
  assert.equal(first.events[0].actorId, "owner");
  assert.equal(first.more, true);
  const second = readDerivedPage(db, "share_links", first.nextCursor, 1);
  assert.equal(second.events.length, 1);
  assert.notEqual(second.events[0].sourceKey, first.events[0].sourceKey);
  assert.equal(second.more, false);

  db.exec(`CREATE TABLE referral_invites (jti TEXT PRIMARY KEY, room_id TEXT, inviter_member_id TEXT, depth INTEGER, created_at INTEGER)`);
  db.exec(`INSERT INTO referral_invites VALUES('j1','alpha','owner', 1, 30)`);
  const sent = readDerivedPage(db, "referral_invites", null, 10);
  assert.deepEqual(sent.events.map(event => event.name), ["member_invited", "referral_sent"]);
  assert.equal(sent.events[1].props.channel, "agent_referral");

  db.exec(`CREATE TABLE referrals (room_id TEXT, referrer_member_id TEXT, referee_member_id TEXT, via TEXT, activated_at INTEGER)`);
  db.exec(`INSERT INTO referrals VALUES('alpha','owner','agent1','invite', 40)`);
  const activated = readDerivedPage(db, "referrals", null, 10);
  assert.equal(activated.events[0].name, "referral_activated");
  assert.equal(activated.events[0].refMemberId, "owner");

  const absent = readDerivedPage(db, "guest_invites", null, 10);
  assert.equal(absent.missing, true);
  assert.deepEqual(absent.events, []);

  const tailDb = new DatabaseSync(":memory:");
  tailDb.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT)");
  tailDb.exec("INSERT INTO rooms VALUES('alpha', 0, '{}')");
  ensureAnalyticsSchema(tailDb);
  const result = await runAnalyticsTail(tailDb, { now: 1_700_000_000_000, budgetMs: 5000 });
  assert.equal(result.errors, 0);
  assert.equal(dailyValue(tailDb, "2023-11-14", "missing_table"), derivedSources().length);
  db.close();
  tailDb.close();
});
