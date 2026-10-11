// tests/approval-inbox-e2e.test.js
//
// WAVE-500 guild 10 slice 30/50: approval-inbox END-TO-END journey test.
//
// One tap's full journey through the unified approval inbox — one live
// surface for pending HUMAN decisions, replacing the scattered tap list:
//
//   1. policy qualifies a money tap            (sibling slice 1 — vendored)
//   2. template instantiates a card draft      (sibling slice 2 — NOT LANDED)
//   3. store creates the card                  (sibling slice 3 — vendored)
//   4. routes expose it via GET                (sibling slice 4 — NOT LANDED)
//   5. human decide via POST → approved        (sibling slice 4 — NOT LANDED)
//   6. receipt linkage recorded                (sibling slice 7 — NOT LANDED)
//   7. audit journal has the entry             (sibling slice 13 — NOT LANDED)
//   8. metrics count it decided                (sibling slices 25/26 — NOT LANDED)
//
// GAP LEDGER (honest skips — never fake passes):
//   Leg 2 (templates): skipped. No card-draft module exists yet; the test
//     harness builds the draft inline from the policy verdict, documented as
//     standing in for the unlanded templates slice. Upgrade to a real leg-2
//     assertion when the templates slice lands.
//   Legs 4+5 (routes): skipped. No HTTP surface exists. Leg 4 has a store
//     seam test (listCards exposes pending cards for the GET route to read)
//     and leg 5 has a store seam test (decideCard records the human decision
//     the POST route will call) — both labeled as seams, not the HTTP legs.
//   Leg 6 (receipts): skipped. No receipt-linkage module exists yet.
//   Leg 7 (journal): skipped. No approval-inbox audit-journal module exists.
//   Leg 8 (metrics): skipped. No approval-inbox metrics module exists.
//
// FIXTURE NOTE: the policy and store modules are not on main yet (policy is
// open as PR #2557; store lives in the sibling's working tree), so this e2e
// imports pinned copies vendored under tests/fixtures/approval-inbox-e2e/.
// Delete the fixtures and re-point these imports at ../server/ when the
// sibling PRs merge.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  qualifiesForInbox,
  urgencyOf,
  expiryFor,
} from "./fixtures/approval-inbox-e2e/approval-inbox-policy.mjs";
import {
  ApprovalInboxStore,
  ApprovalInboxError,
} from "./fixtures/approval-inbox-e2e/approval-inbox-store.mjs";

const NOW = Date.UTC(2026, 9, 10, 20, 0, 0); // 2026-10-10 20:00 PDT — injected clock, no I/O

// The tap: a real money move from the standing tap list. Rule 1 — no
// spending without John's explicit tap, no exceptions, no matter the amount.
const MONEY_TAP = {
  kind: "money",
  payload: {
    what: "Upwork Connects top-up ($60)",
    amountUsd: 60,
    vendor: "Upwork",
    requestedBy: "jill",
  },
};

function freshStore(clock = () => NOW) {
  let seq = 0;
  const db = new DatabaseSync(":memory:");
  const store = new ApprovalInboxStore({ db, now: clock, newId: () => `e2e-card-${++seq}` });
  return { db, store };
}

// The draft the templates slice will one day instantiate from the policy
// verdict. Built here from the verdict + tap so the store leg (3) can run
// against a policy-informed draft; this is the harness standing in for the
// unlanded slice 2, not a fake pass of leg 2.
function draftFromTap(tap, verdict, now) {
  assert.equal(verdict.qualifies, true, "draft is only built for a qualified tap");
  return {
    kind: tap.kind,
    title: `Approve ${tap.payload.what}`,
    what:
      `Spend $${tap.payload.amountUsd} on ${tap.payload.vendor} Connects so the ` +
      `buyer pipeline can send first-messages. ${verdict.rationale}`,
    context: {
      links: [{ label: "standing tap list", url: "https://example.invalid/taps/2026-09-22" }],
      note: verdict.rationale,
    },
    options: [
      {
        label: "Approve once",
        consequence: `$${tap.payload.amountUsd} leaves the Upwork balance; the pipeline proceeds.`,
      },
      {
        label: "Deny",
        consequence: "No spend; the buyer pipeline stays parked on Connects.",
      },
    ],
    requestedBy: tap.payload.requestedBy,
    expiresAt: Date.parse(expiryFor(tap.kind, now)),
  };
}

// --- leg 1: policy qualifies the money tap --------------------------------

test("leg 1: policy qualifies a money tap — even a small one", () => {
  const verdict = qualifiesForInbox(MONEY_TAP);
  assert.equal(verdict.qualifies, true);
  assert.match(verdict.rationale, /tap|spend|payment/i);
});

test("leg 1: money is URGENT and gets a 24h expiry — no carve-outs", () => {
  assert.equal(urgencyOf(MONEY_TAP, NOW), 2); // URGENT
  const iso = expiryFor("money", NOW);
  assert.equal(Date.parse(iso), NOW + 24 * 3600_000);
});

test("leg 1: blanket 'approve everything' is REFUSED — the inbox never auto-approves", () => {
  const verdict = qualifiesForInbox({
    kind: "money",
    payload: { ...MONEY_TAP.payload, action: "approve-all" },
  });
  assert.equal(verdict.qualifies, false);
  assert.equal(verdict.reason, "refused");
});

test("leg 2 skipped: templates slice not landed — no card-draft module exists to instantiate from the policy verdict", { skip: true }, () => {});

// --- leg 3: store creates the card ----------------------------------------

test("leg 3: store creates the card from the policy-informed draft", () => {
  const { store } = freshStore();
  const draft = draftFromTap(MONEY_TAP, qualifiesForInbox(MONEY_TAP), NOW);
  const card = store.createCard(draft);

  assert.equal(card.status, "pending");
  assert.equal(card.kind, "money");
  assert.equal(card.title, "Approve Upwork Connects top-up ($60)");
  assert.match(card.what, /\$60/);
  assert.equal(card.requestedBy, "jill");
  assert.equal(card.decision, null);
  assert.equal(card.expiresAt, NOW + 24 * 3600_000);
  assert.equal(card.options.length, 2);
});

test("leg 4 seam: pending cards are listable — the GET route will read this", () => {
  const { store } = freshStore();
  const draft = draftFromTap(MONEY_TAP, qualifiesForInbox(MONEY_TAP), NOW);
  const card = store.createCard(draft);

  const pending = store.listCards({ status: "pending" });
  assert.ok(pending.some(c => c.id === card.id), "created card is visible as pending");
  assert.ok(pending.every(c => c.status === "pending"));
});

test("leg 4 skipped: routes slice not landed — no HTTP GET surface exists", { skip: true }, () => {});

// --- leg 5: the human decides ----------------------------------------------

test("leg 5 seam: store.decideCard records the human decision the POST route will call", () => {
  const { store } = freshStore();
  const draft = draftFromTap(MONEY_TAP, qualifiesForInbox(MONEY_TAP), NOW);
  const card = store.createCard(draft);

  const { card: decided, decision } = store.decideCard(card.id, {
    decision: "approve",
    decidedBy: "John",
  });
  assert.equal(decided.status, "approved");
  assert.equal(decision.decision, "approve");
  assert.equal(decision.decidedBy, "John");
  assert.equal(store.getCard(card.id).decision.decidedBy, "John");
});

test("leg 5 seam: decisions are never overwritten — a second different decision is refused", () => {
  const { store } = freshStore();
  const draft = draftFromTap(MONEY_TAP, qualifiesForInbox(MONEY_TAP), NOW);
  const card = store.createCard(draft);
  store.decideCard(card.id, { decision: "approve", decidedBy: "John" });

  assert.throws(
    () => store.decideCard(card.id, { decision: "deny-stop", decidedBy: "John" }),
    error => error instanceof ApprovalInboxError && error.code === "invalid_transition",
  );
});

test("leg 5 skipped: routes slice not landed — no HTTP POST decide surface exists", { skip: true }, () => {});

test("leg 6 skipped: receipts slice not landed — no receipt-linkage module exists", { skip: true }, () => {});

test("leg 7 skipped: journal slice not landed — no audit-journal module exists", { skip: true }, () => {});

test("leg 8 skipped: metrics slice not landed — no metrics module exists", { skip: true }, () => {});

// --- the full journey, spine through the landed legs -----------------------

test("journey: one money tap, policy → card → human approval, end to end", () => {
  const { store } = freshStore();

  // 1. the tap qualifies
  const verdict = qualifiesForInbox(MONEY_TAP);
  assert.equal(verdict.qualifies, true);

  // 2. (templates slice not landed — harness builds the draft, see header)
  const draft = draftFromTap(MONEY_TAP, verdict, NOW);

  // 3. the card exists, pending
  const card = store.createCard(draft);
  assert.equal(card.status, "pending");
  assert.match(card.what, /Upwork Connects/);
  assert.match(card.what, /\$60/);

  // 4+5. the card is visible, then the human approves (seams for routes)
  assert.ok(store.listCards({ status: "pending" }).some(c => c.id === card.id));
  const { card: decided } = store.decideCard(card.id, { decision: "approve", decidedBy: "John" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decision.decision, "approve");

  // 6+7+8. receipt linkage, audit journal, metrics — unlanded; the gap is
  // recorded as skipped tests above, not as passes here.
  assert.equal(store.listCards({ status: "pending" }).length, 0);
  assert.equal(store.listCards({ status: "approved" }).length, 1);
});
