// SEC-04 (2026-10-05): account deletion completeness. Before this fix,
// account-keyed inbox/channel rows (handoff packets, SLA breach alerts,
// channel update journal, channel live status) survived deletion, and
// unredeemed agent and referral invites minted by the account's room
// members stayed redeemable after the account left its rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { planAccountDeletion, executeAccountDeletion, inventoryFromStore, RETENTION_POLICY } from "../server/account-deletion.mjs";

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => Date.now() });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const A = "u-sec04";
  const db = store.db;
  db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,'test',?)").run(A, Date.now());
  db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES('commons','m-sec04',?,'test')").run(A);
  return { store, A };
}

function seedDerivedInbox(store, A) {
  const db = store.db;
  db.prepare(`INSERT INTO inbox_handoffs(handoff_id,account_id,thread_id,channel,packet,from_agent,to_agent,status,created_at,updated_at,history)
    VALUES('h1',?,'t1','email','{}','a1','a2','open',1,1,'[]')`).run(A);
  db.prepare(`INSERT INTO sla_breach_alerts(id,account_id,thread_id,channel,kind,elapsed_ms,target_ms,awaiting_since,produced_at,summary,decision,reason,prefs_snapshot,notified_at,created_at)
    VALUES('s1',?,'t1','email','reply',10,5,'2026-10-05','2026-10-05','private summary','notify','late','{}',1,1)`).run(A);
  db.prepare("INSERT INTO private_email_connections(account_id,id,provider,mailbox_id,data_json) VALUES(?,'c1','telegram','mb1','{}')").run(A);
  db.prepare(`INSERT INTO pending_channel_updates(account_id,connection_id,update_id,received_at,payload,status,attempts,updated_at)
    VALUES(?,'c1',1,1,'{}','pending',0,1)`).run(A);
  db.prepare(`INSERT INTO telegram_live_status(account_id,connection_id,updated_at) VALUES(?,'c1',1)`).run(A);
}

function seedMemberInvites(store) {
  const db = store.db;
  const far = Date.now() + 86_400_000;
  db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,created_at,expires_at) VALUES(?,'commons','m-sec04','[]',1,?)`).run("aa".repeat(32), far);
  db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,created_at,expires_at,redeemed_at) VALUES(?,'commons','m-sec04','[]',1,?,2)`).run("bb".repeat(32), far);
  db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,created_at,expires_at) VALUES(?,'commons','m-other','[]',1,?)`).run("cc".repeat(32), far);
  db.prepare(`INSERT INTO referral_invites(jti,room_id,chain_id,inviter_member_id,depth,max_depth,created_at,expires_at) VALUES('r1','commons','ch1','m-sec04',0,3,1,?)`).run(far);
  db.prepare(`INSERT INTO referral_invites(jti,room_id,chain_id,inviter_member_id,depth,max_depth,created_at,expires_at) VALUES('r2','commons','ch2','m-other',0,3,1,?)`).run(far);
}

const deleteAccount = (store, A) => executeAccountDeletion(store, planAccountDeletion(store, A).plan);
const count = (store, table, A) => store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(A).n;

test("account-keyed inbox and channel rows are purged on account deletion", t => {
  const { store, A } = setup(t);
  seedDerivedInbox(store, A);
  assert.equal(inventoryFromStore(store, A).derived_inbox.itemCount, 4);
  deleteAccount(store, A);
  for (const table of ["inbox_handoffs", "sla_breach_alerts", "pending_channel_updates", "telegram_live_status"]) {
    assert.equal(count(store, table, A), 0, `${table} survived deletion`);
  }
});

test("unredeemed agent and referral invites minted by the account's members are revoked, others untouched", t => {
  const { store, A } = setup(t);
  seedMemberInvites(store);
  assert.equal(inventoryFromStore(store, A).member_issued_invites.itemCount, 2);
  deleteAccount(store, A);
  const db = store.db;
  const agent = Object.fromEntries(db.prepare("SELECT code_hash, revoked_at FROM agent_invite_codes").all().map(r => [r.code_hash.slice(0, 2), r.revoked_at]));
  assert.ok(agent.aa, "own unredeemed agent invite is revoked");
  assert.equal(agent.bb, null, "redeemed history is not rewritten");
  assert.equal(agent.cc, null, "another member's invite is untouched");
  const referral = Object.fromEntries(db.prepare("SELECT jti, status, reject_reason FROM referral_invites").all().map(r => [r.jti, r]));
  assert.equal(referral.r1.status, "rejected");
  assert.equal(referral.r1.reject_reason, "inviter_account_deleted");
  assert.equal(referral.r2.status, "minted");
  assert.equal(count(store, "member_accounts", A), 0, "memberships still drop after revocation");
});

test("deletion plan and retention policy disclose the SEC-04 categories", t => {
  const { store, A } = setup(t);
  seedDerivedInbox(store, A);
  seedMemberInvites(store);
  const { plan } = planAccountDeletion(store, A);
  const steps = plan.steps.map(s => s.category);
  assert.ok(steps.includes("derived_inbox"));
  assert.ok(steps.indexOf("derived_inbox") < steps.indexOf("private_email"), "channel journal purges before its email connection");
  assert.ok(steps.indexOf("member_issued_invites") < steps.indexOf("memberships"), "invite revocation runs before memberships drop");
  const purged = RETENTION_POLICY.purged.map(p => p.category);
  assert.ok(purged.includes("derived_inbox") && purged.includes("member_issued_invites"));
});
