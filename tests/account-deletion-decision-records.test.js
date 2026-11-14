// #3614 (accountability R-3) filed acceptance: decision records — verdicts,
// receipts, settlements, and their underlying events — carry an explicit
// retention class in RETENTION_POLICY (>=4 years, legal hold), and a
// deletion plan shows them retained/anonymized, never purged. Before this
// lane the class did not exist anywhere: the records below persisted only
// incidentally, and nothing an auditor could be shown declared a period.
//
// Scenario: an account that is a party to a settled bounty (bounty_records)
// plus a public receipt and its review verdict is deleted through the real
// plan + execute path. The decision rows stay byte-identical; the person
// is anonymized (profile scrubbed to the deactivated tombstone, membership
// binding purged).
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
import { DECISION_RECORD_RETENTION_DAYS } from "../server/audit-retention.mjs";
import { publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { publicWorkReviewsSchema } from "../server/public-work-reviews.mjs";

const A = "u-decision";
const MEMBER = "m-decision";

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => Date.now() });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const db = store.db;
  db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at,display_name) VALUES(?,1,0,0,'test',?,?)")
    .run(A, Date.now(), "Decision Person");
  db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES('commons',?,?,'test')").run(MEMBER, A);
  return { store, A };
}

function seedDecisionRecords(store) {
  const db = store.db;
  // A settled bounty the account posted (a settlement + verdict record),
  // and one posted by another member (not attributable to this account).
  const bounty = `INSERT INTO bounty_records(bounty_id,room_id,title,criteria,amount_millis,poster,verifier,state,state_changed_ms,deadline_ms,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
  db.prepare(bounty).run("b-own", "commons", "Settled work", "criteria", 10000, MEMBER, "m-verifier", "paid", 1, 2, "2026-01-01", "2026-01-02");
  db.prepare(bounty).run("b-other", "commons", "Someone else's", "criteria", 5000, "m-other", "m-verifier", "paid", 1, 2, "2026-01-01", "2026-01-02");
  // A public receipt and the review verdict recorded on it.
  db.exec(publicWorkClaimsSchema);
  db.exec(publicWorkReviewsSchema);
  db.prepare(`INSERT INTO public_work_tasks(offer_id,namespace_key,room_id,terms_version,repository_url,repository_ref,files_json,generation,created_at)
    VALUES('offer-1','ns','commons',1,'https://example.com/repo','main','[]',0,1)`).run();
  db.prepare(`INSERT INTO public_work_receipts(receipt_id,offer_id,namespace_key,generation,identity_id,artifact_text,artifact_sha256,artifact_bytes,receipt_json,created_at)
    VALUES('rc-1','offer-1','ns',0,'identity-1','artifact','aa',8,'{}',1)`).run();
  db.prepare(`INSERT INTO public_work_reviews(receipt_id,room_id,revision,state_json)
    VALUES('rc-1','commons',1,'{"state":"verified","verification":{"verdict":"PASS"},"decision":{"decision":"accepted"}}')`).run();
}

test("RETENTION_POLICY declares the decision-record class at >=4 years under legal hold", () => {
  assert.equal(DECISION_RECORD_RETENTION_DAYS, 1460, "the class floor is 4 years (4 x 365)");
  const entry = RETENTION_POLICY.retained.find(e => e.category === "decision_records");
  assert.ok(entry, "retention policy discloses the decision_records class");
  assert.equal(entry.retentionDays, DECISION_RECORD_RETENTION_DAYS,
    "the policy class and the audit classifier share one floor constant");
  assert.ok(entry.retentionDays >= 1460, "the declared class is at least 4 years");
  assert.equal(entry.legalHold, true, "the class is under legal hold");
  assert.match(entry.reason, /verdicts/i);
  assert.match(entry.reason, /receipts/i);
  assert.match(entry.reason, /settlements/i);
  assert.match(entry.reason, /at least 4 years/);
  assert.ok(!RETENTION_POLICY.purged.some(e => e.category === "decision_records"),
    "the policy never promises decision records are purged");
  assert.match(RETENTION_POLICY.summary, /decision records \(verdicts, receipts, settlements/i);
  assert.match(RETENTION_POLICY.summary, /at least 4 years/);
});

test("deletion plan shows decision records retained under legal hold, never purged", t => {
  const { store, A } = setup(t);
  seedDecisionRecords(store);
  const inventory = inventoryFromStore(store, A);
  assert.ok(inventory.decision_records.legalHold, "decision_records is a legal-hold (retained) category");
  assert.equal(inventory.decision_records.itemCount, 1,
    "count covers the bounty_records rows the account's member is a party to (not other members' rows)");
  const { plan, summary } = planAccountDeletion(store, A);
  assert.ok(plan.categories.includes("decision_records"), "plan includes decision_records");
  const step = plan.steps.find(s => s.category === "decision_records");
  assert.equal(step.action, "retain", "decision_records plan step retains, never purges");
  assert.match(step.reason, /at least 4 years/);
  assert.ok(summary.text.includes("decision_records"), "confirmation summary discloses the retention");
});

test("account deletion anonymizes the person and keeps every decision record", t => {
  const { store, A } = setup(t);
  seedDecisionRecords(store);
  const { plan } = planAccountDeletion(store, A);
  const result = executeAccountDeletion(store, plan);
  const db = store.db;
  assert.ok(result.retained.some(r => r.category === "decision_records"), "deletion result reports decision records as retained");
  assert.ok(!result.purged.some(r => r.category === "decision_records"), "deletion result never reports decision records as purged");
  // The decisions stay, byte-identical.
  assert.equal(db.prepare("SELECT count(*) AS n FROM bounty_records").get().n, 2, "bounty verdict/settlement records stay");
  assert.equal(db.prepare("SELECT state FROM bounty_records WHERE bounty_id='b-own'").get().state, "paid");
  assert.equal(db.prepare("SELECT count(*) AS n FROM public_work_receipts WHERE receipt_id='rc-1'").get().n, 1, "receipt stays");
  const review = db.prepare("SELECT state_json FROM public_work_reviews WHERE receipt_id='rc-1'").get();
  assert.match(review.state_json, /"verdict":"PASS"/, "the verdict on the receipt stays");
  // The person is anonymized: tombstone profile, membership gone.
  const account = db.prepare("SELECT active, display_name FROM accounts WHERE id=?").get(A);
  assert.equal(account.active, 0, "account is a deactivated tombstone");
  assert.equal(account.display_name, null, "profile is scrubbed (hold-and-anonymize)");
  assert.equal(db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get(A).n, 0,
    "membership binding is purged");
});
