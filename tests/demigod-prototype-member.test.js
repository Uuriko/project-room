// Challenge to #1822 (is-sec-4, fixes #1004): the own-property member lookup
// fix covered agent-identities.link(), but the same flaw class persists in the
// Demigod paid rails. A caller-supplied member id naming an inherited
// Object.prototype property ("toString", "valueOf", "hasOwnProperty", ...)
// passes validId (only "constructor"/"prototype"/"__proto__" are excluded)
// and resolves truthy via members[id], so "must be an active room member"
// gates treat a phantom as a member. Contracts, offers, trials, and sign-off
// loops can be minted naming parties that do not exist.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Contract: "active room member" checks admit only own members of the
//    room projection; inherited prototype names are rejected.
// 2. Credible regression: dropping the own-property guard (or a new rail
//    copying the `members[id]` pattern) silently mints paid-rail records
//    naming phantom parties — the exact class #1004 fixed in link().
// 3. Existing coverage: #1822's tests pin link() only; nothing pins the four
//    rails below (verified: agent-identities.test.js #1004 cases exercise
//    only /identity-links).
// 4. No production seam: exercises the real store modules against a real
//    RoomStore; the fix is a shared own-property helper in src/events.js,
//    no test-only export.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { addRailMember, submittedTrial } from "../scripts/record-rails-fixture.mjs";

const PHANTOMS = ["toString", "valueOf", "hasOwnProperty"];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "demigod-proto-member-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  addRailMember(store, "worker-1");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store };
}

const offerInput = (id = "dg-offer-1") => ({
  requestId: `create-${id}`, offerId: id,
  reviewerMemberIds: ["owner"],
  terms: {
    repositoryUrl: "https://github.com/Uuriko/project-room",
    kind: "project", title: "Paid trial", summary: "x",
    acceptanceCriteria: ["ok"],
    reward: { kind: "cash", unit: "USD", amountMinor: "5000" },
    approvalPolicy: { mode: "human" },
  },
});

const profileInput = (profileId = "dgp-1", buyerId = "owner") => ({
  requestId: `profile-${profileId}`, profileId,
  offerRef: "dg-offer-1", demigodReqId: "demigod-req-42", buyerId,
  trialScope: { hours: "40", deliverableShape: "code-pr" },
  vettingRubric: [{ criterionId: "c1", description: "d", maxScore: "5.00" }],
  priceType: "fixed", priceMilli: "5000000",
  timeline: { estimateDays: "14", deadline: "2026-11-01T00:00:00.000Z" },
  revisionTerms: { maxRounds: 2, turnaroundDays: "3" },
});

function acceptedOffer(t, buyerId = "owner") {
  const { store } = fixture(t);
  store.projectOffers.create("commons", "owner", offerInput());
  store.demigodOffers.create("commons", "owner", profileInput("dgp-1", buyerId));
  store.demigodOffers.present("commons", "owner", "dgp-1", { requestId: "p1", expectedRevision: 1 });
  store.demigodOffers.accept("commons", "owner", "dgp-1", { requestId: "a1", expectedRevision: 2 });
  return { store };
}

test("contracts: workerId naming an inherited prototype property is rejected", t => {
  const { store } = acceptedOffer(t);
  for (const phantom of PHANTOMS) {
    assert.throws(
      () => store.demigodContracts.create("commons", "owner", {
        requestId: `evil-${phantom}`, contractId: `dgc-evil-${phantom}`,
        offerProfileId: "dgp-1", expectedRevision: 3, workerId: phantom,
      }),
      error => error.code === "invalid_contract_worker",
      `workerId=${phantom} must be rejected as a non-member`,
    );
  }
  // Positive control: a real member still mints.
  const contract = store.demigodContracts.create("commons", "owner", {
    requestId: "ok-1", contractId: "dgc-ok", offerProfileId: "dgp-1",
    expectedRevision: 3, workerId: "worker-1",
  });
  assert.equal(contract.parties.workerId, "worker-1");
});

test("offers: buyerId naming an inherited prototype property is rejected", t => {
  const { store } = fixture(t);
  store.projectOffers.create("commons", "owner", offerInput());
  for (const phantom of PHANTOMS) {
    assert.throws(
      () => store.demigodOffers.create("commons", "owner", profileInput(`dgp-evil-${phantom}`, phantom)),
      error => error.code === "invalid_demigod_offer",
      `buyerId=${phantom} must be rejected as a non-member`,
    );
  }
  // Positive control: a real member still creates.
  const profile = store.demigodOffers.create("commons", "owner", profileInput("dgp-ok", "owner"));
  assert.equal(profile.buyerId, "owner");
});

test("trials: candidateId/buyerId naming an inherited prototype property are rejected", t => {
  const { store } = fixture(t);
  const input = overrides => ({
    action: "create", requestId: `t-${Math.random().toString(16).slice(2, 8)}`,
    taskId: `task-${Math.random().toString(16).slice(2, 8)}`,
    candidateId: "worker-1", buyerId: "owner",
    demigodReqId: "d-1", title: "trial",
    trialScope: { hoursMax: "40", deliverableShape: "PR + write-up" },
    vettingRubric: [{ criterion: "correctness", weightBps: "10000" }],
    feePolicyRef: "fee-policy/x",
    ...overrides,
  });
  for (const phantom of PHANTOMS) {
    assert.throws(
      () => store.trialTasks.apply("commons", "owner", input({ candidateId: phantom })),
      error => error.code === "invalid_trial_party",
      `candidateId=${phantom} must be rejected as a non-member`,
    );
    assert.throws(
      () => store.trialTasks.apply("commons", "owner", input({ buyerId: phantom })),
      error => error.code === "invalid_trial_party",
      `buyerId=${phantom} must be rejected as a non-member`,
    );
  }
  // Positive control: real members still record.
  const task = store.trialTasks.apply("commons", "owner", input({}));
  assert.equal(task.buyerId, "owner");
});

test("sign-off: buyerId naming an inherited prototype property is rejected before trial binding", t => {
  const { store } = fixture(t);
  submittedTrial(store); // trial-abc123, buyerId "owner", state submitted
  for (const phantom of PHANTOMS) {
    assert.throws(
      () => store.buyerSignoff.create("commons", "owner", {
        requestId: `s-${phantom}`, loopId: `loop-${phantom}`,
        trialTaskId: "trial-abc123", buyerId: phantom,
      }),
      error => error.code === "invalid_signoff",
      `buyerId=${phantom} must fail the member gate, not trial binding`,
    );
  }
  // Positive control: the real buyer still opens a loop.
  const loop = store.buyerSignoff.create("commons", "owner", {
    requestId: "s-ok", loopId: "loop-ok", trialTaskId: "trial-abc123", buyerId: "owner",
  });
  assert.equal(loop.status, "open");
});
