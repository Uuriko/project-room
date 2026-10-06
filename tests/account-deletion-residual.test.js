// QA slice D (2026-10-04): account deletion must purge the private inbox,
// connected email data, and derived stitch rows, and must revoke access the
// account issued (guest invites, share links, membership invitations) plus
// disconnect agents it sponsored. Regression tests for the residual-data
// gap: before the fix, every assertion below failed — rows survived a live
// deletion run and nothing in the confirmation summary disclosed them.
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

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => Date.now() });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const A = "u-residual";
  store.db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,'test',?)")
    .run(A, Date.now());
  return { store, A };
}

function seedPrivateData(store, A) {
  const db = store.db;
  db.prepare("INSERT INTO private_inbox_sources(account_id,id,revision,created_at,updated_at) VALUES(?,?,1,1,1)")
    .run(A, "src1");
  db.prepare("INSERT INTO private_inbox_versions(account_id,source_id,revision,data_json) VALUES(?,?,1,?)")
    .run(A, "src1", '{"adapter":"email","envelope":{"message":{"subject":"secret"}}}');
  db.prepare("INSERT INTO private_inbox_drafts(account_id,source_id,revision,source_revision,body,updated_at) VALUES(?,?,1,1,?,1)")
    .run(A, "src1", "secret draft");
  db.prepare("INSERT INTO private_inbox_reads(account_id,source_id,read_at) VALUES(?,?,1)").run(A, "src1");
  db.prepare("INSERT INTO private_inbox_commands(account_id,sequence,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?,?)")
    .run(A, 1, "rq1", "fp", '{"action":"source.import"}', '{"ok":true}', 0, 1);
  db.prepare("INSERT INTO private_email_connections(account_id,id,provider,mailbox_id,data_json) VALUES(?,?,?,?,?)")
    .run(A, "conn1", "gmail", "mb1", '{"token":"secret"}');
  db.prepare("INSERT INTO private_email_folders(account_id,connection_id,folder_id,data_json) VALUES(?,?,?,?)")
    .run(A, "conn1", "INBOX", '{"name":"INBOX"}');
  db.prepare("INSERT INTO stitch_identities(account_id,stitch_key,id_type,channel,kind,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)")
    .run(A, "k1", "email", "email", "person", "2026-01-01", "2026-01-02");
}

function seedIssuedAccess(store, A) {
  const db = store.db;
  db.prepare(`INSERT INTO guest_invites(id,code_hash,room_id,tier,credential_ttl_ms,guest_label,
    minted_by_member_id,minted_by_account_id,issue_request_id,created_at,redeem_by,status)
    VALUES('gi-active',?, 'commons','observer',3600000,'g','m1',?,'rq1',1,9999999999999,'active')`)
    .run("aa".repeat(32), A);
  db.prepare(`INSERT INTO guest_invites(id,code_hash,room_id,tier,credential_ttl_ms,guest_label,
    minted_by_member_id,minted_by_account_id,issue_request_id,created_at,redeem_by,status)
    VALUES('gi-redeemed',?, 'commons','observer',3600000,'g','m1',?,'rq2',1,9999999999999,'redeemed')`)
    .run("bb".repeat(32), A);
  db.prepare(`INSERT INTO share_links(id,token_hash,room_id,issuer_account_id,issuer_member_id,issuer_auth_epoch,
    issuer_member_revision,request_id,fingerprint,created_at,expires_at,max_joins)
    VALUES('sl1',?, 'commons',?,'m1',0,0,'rq1','fp',1,9999999999999,5)`)
    .run("cc".repeat(32), A);
}

function deleteAccount(store, A) {
  const { plan } = planAccountDeletion(store, A);
  return executeAccountDeletion(store, plan);
}

test("private inbox content is purged on account deletion", t => {
  const { store, A } = setup(t);
  seedPrivateData(store, A);
  deleteAccount(store, A);
  const db = store.db;
  for (const table of ["private_inbox_sources", "private_inbox_versions", "private_inbox_drafts", "private_inbox_reads"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(A).n, 0, `${table} purged`);
  }
});

test("inbox version immutability triggers are restored after deletion", t => {
  const { store, A } = setup(t);
  seedPrivateData(store, A);
  deleteAccount(store, A);
  const db = store.db;
  for (const name of ["private_inbox_versions_no_delete", "private_inbox_versions_no_update"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name),
      `${name} recreated after deletion`);
  }
  // The trigger still guards the table for everyone else.
  db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES('u-other',1,0,0,'test',1)").run();
  db.prepare("INSERT INTO private_inbox_sources(account_id,id,revision,created_at,updated_at) VALUES('u-other','s9',1,1,1)").run();
  db.prepare("INSERT INTO private_inbox_versions(account_id,source_id,revision,data_json) VALUES('u-other','s9',1,'{}')").run();
  assert.throws(() => db.prepare("DELETE FROM private_inbox_versions WHERE account_id='u-other'").run(),
    /source versions are retained/);
});

test("private email connections and folders are purged", t => {
  const { store, A } = setup(t);
  seedPrivateData(store, A);
  deleteAccount(store, A);
  const db = store.db;
  assert.equal(db.prepare("SELECT count(*) AS n FROM private_email_folders WHERE account_id=?").get(A).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM private_email_connections WHERE account_id=?").get(A).n, 0);
});

test("stitch rows are purged", t => {
  const { store, A } = setup(t);
  seedPrivateData(store, A);
  deleteAccount(store, A);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM stitch_identities WHERE account_id=?").get(A).n, 0);
});

test("inbox/email command receipts are retained under legal hold and disclosed", t => {
  const { store, A } = setup(t);
  seedPrivateData(store, A);
  const inventory = inventoryFromStore(store, A);
  assert.ok(inventory.inbox_receipts.legalHold, "receipts are a retained category");
  assert.equal(inventory.inbox_receipts.itemCount, 1);
  deleteAccount(store, A);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM private_inbox_commands WHERE account_id=?").get(A).n, 1,
    "receipt journal retained");
  assert.ok(RETENTION_POLICY.retained.some(e => e.category === "inbox_receipts"), "retention policy discloses it");
});

test("account-issued guest invites and share links are revoked, not left active", t => {
  const { store, A } = setup(t);
  seedIssuedAccess(store, A);
  deleteAccount(store, A);
  const db = store.db;
  assert.equal(db.prepare("SELECT status FROM guest_invites WHERE id='gi-active'").get().status, "revoked");
  assert.equal(db.prepare("SELECT status FROM guest_invites WHERE id='gi-redeemed'").get().status, "redeemed",
    "already-redeemed invites keep their history");
  const link = db.prepare("SELECT revoked_at, revoked_by_member_id FROM share_links WHERE id='sl1'").get();
  assert.ok(link.revoked_at !== null, "share link revoked");
  assert.equal(link.revoked_by_member_id, "m1", "revocation attributed to the issuing member");
});

test("deletion plan discloses the new purge categories", t => {
  const { store, A } = setup(t);
  seedPrivateData(store, A);
  seedIssuedAccess(store, A);
  const { plan } = planAccountDeletion(store, A);
  for (const category of ["private_inbox", "private_email", "stitch", "issued_access", "sponsored_agents", "inbox_receipts"]) {
    assert.ok(plan.categories.includes(category), `plan includes ${category}`);
  }
  const counts = Object.fromEntries(plan.steps.map(s => [s.category, s.itemCount]));
  assert.equal(counts.private_inbox, 4);
  assert.equal(counts.private_email, 2);
  assert.equal(counts.issued_access, 2, "active guest invite + unrevoked share link");
  const retained = plan.steps.find(s => s.category === "inbox_receipts");
  assert.equal(retained.action, "retain");
  for (const category of ["private_inbox", "private_email", "stitch", "issued_access", "sponsored_agents"]) {
    assert.ok(RETENTION_POLICY.purged.some(e => e.category === category), `retention policy discloses ${category}`);
  }
  assert.match(RETENTION_POLICY.summary, /private inbox/i);
});
