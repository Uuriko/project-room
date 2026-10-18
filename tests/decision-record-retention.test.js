// Acceptance coverage for #3614 (accountability R-3): decision records —
// verdicts, receipts, settlements, and the events underlying them — had no
// declared retention class. Persistence was incidental (no TTL), and the
// audit-retention severity table (normal 180d, low 30d) would age routine
// decision events out far under the four-year employment-decision regimes
// (CA FEHA ADS, IL IDHR draft) if ever executed as written. Now:
//   - RETENTION_POLICY declares the class explicitly: >=4 years, legal
//     hold, hold-and-anonymize on account deletion (strip the person to
//     the deactivated tombstone, keep the decision record, never purge).
//   - server/audit-retention.mjs floors decision-bearing events at the
//     same constant, so no severity class can classify one below the
//     four-year floor.
//   - the deletion plan carries decision records as a retained category
//     with no purge executor (the #3550 bounty_journal precedent).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";
import {
  RETENTION_POLICY,
  inventoryFromStore,
  planAccountDeletion,
  executeAccountDeletion,
} from "../server/account-deletion.mjs";
import {
  retentionDecisions,
  DECISION_RECORD_FLOOR_DAYS,
  SEVERITY_KEEP_DAYS,
} from "../server/audit-retention.mjs";
import { runRetention } from "../server/retention-run.mjs";

const NOW = "2026-09-16T12:00:00Z";
const daysAgo = days => new Date(Date.parse(NOW) - days * 86400000).toISOString();
// 3.9 years: inside the four-year floor, far outside normal (180d) / low (30d).
const AGE_3_9_YEARS = 1424;

test("RETENTION_POLICY declares the decision-records class: >=4 years, legal hold, hold-and-anonymize", () => {
  assert.equal(RETENTION_POLICY.version, "1.8.0", "policy version bumps for the new class (1.6.0 set the bounty_journal pattern, 1.7.0 followed)");
  const entry = RETENTION_POLICY.retained.find(e => e.category === "decision_records");
  assert.ok(entry, "decision_records is a retained category");
  assert.ok(!RETENTION_POLICY.purged.some(e => e.category === "decision_records"), "decision_records is never a purged category");
  assert.match(entry.reason, /at least four years/);
  assert.match(entry.reason, /legal hold/);
  assert.match(entry.reason, /never purged/);
  assert.match(entry.reason, /verdicts \(public_work_reviews\), receipts \(public_work_receipts\), settlements \(bounty_records\)/);
  assert.match(RETENTION_POLICY.summary, /decision records \(verdicts, receipts, and settlements and the events underlying them\), and the deactivated account tombstone are retained under legal hold/);
  assert.match(RETENTION_POLICY.summary, /decision records are retained for at least four years/);
  assert.match(RETENTION_POLICY.summary, /holds and anonymizes them/);
  const klass = RETENTION_POLICY.decisionRecords;
  assert.ok(klass, "the class is declared as structured policy, not prose alone");
  assert.equal(klass.minimumRetentionDays, DECISION_RECORD_FLOOR_DAYS, "policy floor and audit-retention floor are the same constant");
  assert.ok(klass.minimumRetentionDays >= 1460, "floor is at least four years");
  assert.equal(klass.legalHold, true);
  assert.equal(klass.onAccountDeletion, "hold-and-anonymize");
  assert.deepEqual([...klass.covers], ["verdicts", "receipts", "settlements", "underlying events"]);
});

test("a 3.9-year-old verdict event classifies KEEP at any severity; its non-decision twin purges", () => {
  const verdict = severity => ({ id: `v-${severity}`, at: daysAgo(AGE_3_9_YEARS), severity, decision: true });
  const { decisions, totals } = retentionDecisions([
    verdict("normal"),
    verdict("low"),
    verdict("critical"),
    { id: "routine", at: daysAgo(AGE_3_9_YEARS), severity: "normal" }, // same age, not a decision event
    { id: "routine-low", at: daysAgo(AGE_3_9_YEARS), severity: "low" },
  ], { now: NOW });
  const byId = Object.fromEntries(decisions.map(d => [d.id, d]));
  assert.equal(byId["v-normal"].action, "keep", "3.9y-old verdict event is kept, not purged at the 180d normal class");
  assert.equal(byId["v-low"].action, "keep", "3.9y-old verdict event is kept, not purged at the 30d low class");
  assert.equal(byId["v-critical"].action, "keep");
  assert.equal(byId["v-normal"].keepDays, DECISION_RECORD_FLOOR_DAYS, "normal decision events are floored at four years");
  assert.equal(byId["v-low"].keepDays, DECISION_RECORD_FLOOR_DAYS, "low decision events are floored at four years");
  assert.equal(byId["v-critical"].keepDays, SEVERITY_KEEP_DAYS.critical, "a longer severity period still wins over the floor");
  assert.equal(byId.routine.action, "purge", "non-decision events keep the old severity behavior");
  assert.equal(byId["routine-low"].action, "purge");
  assert.equal(totals.purge, 2, "only the non-decision events purge");
});

test("decision events are kept in place inside the floor and become purge-eligible only past it", () => {
  const { decisions } = retentionDecisions([
    { id: "young-verdict", at: daysAgo(100), severity: "normal", decision: true },
    { id: "young-routine", at: daysAgo(100), severity: "normal" },
    { id: "old-verdict", at: daysAgo(DECISION_RECORD_FLOOR_DAYS + 30), severity: "normal", decision: true },
  ], { now: NOW });
  const byId = Object.fromEntries(decisions.map(d => [d.id, d]));
  assert.equal(byId["young-verdict"].action, "keep", "decision events do not archive inside the floor; they are live proof");
  assert.equal(byId["young-routine"].action, "archive", "routine events still archive after 90 days");
  assert.equal(byId["old-verdict"].action, "purge", "the floor is a minimum, not an eternity: past it the severity rules resume");
});

test("the retention runner never deletes a decision event inside the floor", () => {
  const deleted = [];
  const plan = runRetention({
    events: [
      { id: "verdict-1", at: daysAgo(AGE_3_9_YEARS), severity: "normal", decision: true },
      { id: "routine-1", at: daysAgo(AGE_3_9_YEARS), severity: "normal" },
    ],
    now: NOW,
    allowDeletion: true,
    deleteRecord: item => deleted.push(item),
  });
  assert.deepEqual(deleted, [{ kind: "audit", id: "routine-1" }], "only the routine event is deleted");
  assert.equal(plan.audit.keep, 1);
  assert.equal(plan.audit.purge, 1);
});

// ---- deletion plan / execution against a real store ----

const ROOM = "commons";
const OWNER = "room-owner";   // room owner member; never deleted, holds no account in this test
const POSTER = "u-poster";    // account id == member id
const WORKER = "u-worker";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };

function setup(t) {
  nowMs = 1_786_000_000_000;
  const store = new RoomStore(":memory:", { now: () => nowMs });
  store.initialize(initialRoom(ROOM, OWNER));
  t.after(() => store.close());
  const key = store.issueAccessKey(ROOM, OWNER);
  for (const memberId of [POSTER, WORKER]) {
    store.command(key, ROOM, {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: [...PERMISSIONS] },
    });
    store.createAccount(memberId);
    store.bindHumanAccount(ROOM, memberId, memberId);
  }
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis(ROOM);
  return { store, escrow };
}

// Post -> fund -> claim -> submit -> accept -> challenge window passes ->
// finalize -> epoch sweep. The bounty ends "paid": its bounty_records row
// is the settlement record and its bounty_events rows are the underlying
// decision events.
function settleBounty(escrow) {
  const { bounty } = escrow.postBounty(ROOM, {
    poster: POSTER, title: "Settle me", criteria: "C", amount: 10,
    deadline: new Date(nowMs + 30 * 24 * 3600 * 1000).toISOString(),
  });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, {
    claimant: WORKER,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" },
  });
  escrow.acceptWork(ROOM, bounty.bountyId, {
    acceptor: POSTER,
    verifierAttestation: {
      at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }],
    },
  });
  tick(4 * 24 * 3600 * 1000);
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: POSTER });
  escrow.closeEpoch(ROOM, { caller: POSTER });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("deletion plan holds decision records and execution anonymizes the person, never the decision", t => {
  const { store, escrow } = setup(t);
  const bounty = settleBounty(escrow);
  assert.equal(bounty.state, "paid");
  const db = store.db;

  // A verdict by POSTER on a public-work receipt, recorded the way
  // server/public-work-reviews.mjs writes it (actor inside state_json).
  db.prepare("INSERT INTO public_work_reviews VALUES (?,?,?,?)").run(
    "receipt-3614", ROOM, 1,
    JSON.stringify({ revision: 1, state: "accepted", decision: { decision: "accepted", actorId: POSTER, reason: "ok", at: new Date(nowMs).toISOString() } }));

  const settlementBefore = db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(bounty.bountyId);
  const posterEventsBefore = db.prepare("SELECT count(*) AS n FROM bounty_events WHERE room_id=? AND actor_id=?").get(ROOM, POSTER).n;
  assert.ok(posterEventsBefore >= 1, "the settled bounty has underlying events by the poster");

  // The plan must disclose decision records as retained and count them:
  // the settlement row (poster) + its underlying events + the verdict.
  const inventory = inventoryFromStore(store, POSTER);
  assert.equal(inventory.decision_records.legalHold, true, "decision_records is a legal-hold category");
  assert.equal(inventory.decision_records.itemCount, 1 + posterEventsBefore + 1,
    "settlement + underlying events + verdict attributed to the account are counted");

  const { plan, summary } = planAccountDeletion(store, POSTER);
  const step = plan.steps.find(s => s.category === "decision_records");
  assert.ok(step, "plan includes a decision_records step");
  assert.equal(step.action, "retain", "decision records are retained, never purged (#3614)");
  assert.match(summary.text, /Retention categories retained:.*decision_records/);

  const result = executeAccountDeletion(store, plan);
  assert.ok(result.retained.some(r => r.category === "decision_records"), "result reports decision_records retained");
  assert.ok(!result.purged.some(r => r.category === "decision_records"), "result does not report decision_records purged");

  // Hold-and-anonymize: the person is stripped to the tombstone...
  assert.equal(store.account(POSTER).active, false, "account deactivated");
  assert.equal(db.prepare("SELECT display_name FROM accounts WHERE id=?").get(POSTER).display_name, null,
    "profile scrubbed: the retained records are attributed only to the tombstone");
  assert.equal(db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get(POSTER).n, 0,
    "member bindings purged");

  // ...and the decision records themselves are kept, byte-identical.
  assert.deepEqual(db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(bounty.bountyId), settlementBefore,
    "settlement record retained in place");
  assert.equal(db.prepare("SELECT count(*) AS n FROM bounty_events WHERE room_id=? AND actor_id=?").get(ROOM, POSTER).n,
    posterEventsBefore, "underlying decision events retained");
  assert.equal(db.prepare("SELECT count(*) AS n FROM public_work_reviews WHERE receipt_id=?").get("receipt-3614").n, 1,
    "verdict retained");
});
