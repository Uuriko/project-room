import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTableDigests } from "../server/room-export.mjs";
import { journalEntryHash } from "../server/bounty-escrow.mjs";
import {
  assembleWorkEpisodes, selfDealingRules, stampOf,
} from "../server/work-episode-extract.mjs";

// Fixture builder: an NDJSON snapshot in the exporter's exact shape —
// watermark, {table,row} lines, trailer v2 whose digests come from
// the exporter's own createTableDigests and whose eventsHash follows
// verifyTrailer's algorithm. Journal legs carry REAL hash chains
// (journalEntryHash, chained per account), so the assembler's chain
// re-verification runs against genuine links, not stubs.

const ROOM = "room-alpha";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const MS1 = Date.parse(T1);

const stamp = (principal, model = "model-x") => ({
  sessionInstanceId: `sess_${"a".repeat(24)}`,
  authorizingPrincipalId: principal,
  claimedModelVersion: model,
  claimedHarnessVersion: "harness-1",
  claimedEnvironment: "sandbox",
});
const STAMP_VERDICT = stamp("op_poster_a", "model-verdict");
const STAMP_SUBMIT = stamp("op_poster_a", "model-submit");
const STAMP_JOURNAL = stamp("op_poster_a", "model-journal");
const STAMP_PW = stamp("op_poster_a", "model-pw");
const STAMP_PW2 = stamp("op_owner_b", "model-pw2");

class SnapshotBuilder {
  constructor() {
    this.tables = new Map();
    this.events = [];
    this.journalSeq = 0;
    this.eventSeq = 0;
    this.bountyEventSeq = 0;
    this.chainHeads = new Map();
  }
  add(table, row) {
    const rows = this.tables.get(table) ?? [];
    rows.push(row);
    this.tables.set(table, rows);
    return row;
  }
  roomEvent(id) {
    this.events.push({ room_id: ROOM, sequence: ++this.eventSeq, id, kind: "note", at: T0 });
  }
  leg({ at = T1, kind, bountyId, accountId, amount, lotState = "locked", actorId = "op_actor", provenance = null }) {
    const seq = ++this.journalSeq;
    const key = `${ROOM}\n${accountId}`;
    const entry = {
      seq, room_id: ROOM, entry_id: `je_${seq}`, account_id: accountId, at, kind,
      bounty_id: bountyId, lot_id: `lot_${bountyId}`, amount, lot_state: lotState,
      prev_hash: this.chainHeads.get(key) ?? "0".repeat(64), hash: null,
      memo: null, actor_kind: "member", actor_id: actorId, receipt_id: null,
      track: null, provenance_json: provenance ? JSON.stringify(provenance) : null,
    };
    entry.hash = journalEntryHash(entry);
    this.chainHeads.set(key, entry.hash);
    return this.add("bounty_journal", entry);
  }
  move({ kind, bountyId, from, to, amount, at = T1, provenance = null }) {
    this.leg({ kind, bountyId, accountId: from, amount: -amount, at });
    this.leg({ kind, bountyId, accountId: to, amount, at, provenance });
  }
  bountyEvent(bountyId, afterState, at = T1) {
    this.add("bounty_events", {
      seq: ++this.bountyEventSeq, room_id: ROOM, at, type: "transition", bounty_id: bountyId,
      actor_kind: "member", actor_id: "op_actor", before_state: null, after_state: afterState,
      track: null, data: null,
    });
  }
  lines() {
    const digests = createTableDigests();
    const out = [JSON.stringify({
      kind: "watermark", version: 1, sanitizePolicy: 2, backedUpAt: T2,
      rooms: [{ id: ROOM, sequence: this.eventSeq }], events: this.eventSeq,
    })];
    for (const row of this.events) { out.push(JSON.stringify({ table: "events", row })); digests.add("events", row); }
    for (const [table, rows] of this.tables)
      for (const row of rows) { out.push(JSON.stringify({ table, row })); digests.add(table, row); }
    const tuples = this.events.map(r => [r.room_id, r.sequence, r.id])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const hash = createHash("sha256");
    for (const [roomId, sequence, id] of tuples) hash.update(`${roomId}\t${sequence}\t${id}\n`);
    out.push(JSON.stringify({
      kind: "trailer", version: 2, events: this.events.length,
      eventsHash: hash.digest("hex"), tables: digests.finish(),
    }));
    return out;
  }
}

const bountyRow = (over = {}) => ({
  bounty_id: "bty_x", room_id: ROOM, title: "Do the work", criteria: "criterion text",
  amount_millis: 4000, poster: "op_poster_a", verifier: "op_verifier_a",
  dispute_decider: "op_decider", approval_mode: "agent", claimant: null, state: "proposed",
  state_changed_ms: MS1, deadline_ms: null, challenge_ends_ms: null, dispute_id: null,
  dispute_opened_ms: null, evidence_json: null, attestation_json: null, resolution_json: null,
  rubric_json: null, rubric_hash: "rh_x", rubric_version: 1, submission_hash: null,
  created_at: T0, updated_at: T1, ...over,
});
const json = value => JSON.stringify(value);

// A full paid lifecycle's legs for one bounty: fund, attribute,
// approve, pay out, and (optionally) the keeper's fee.
function paidLegs(b, { bountyId, posterAcct, claimantAcct, amount = 4000, fee = 0, payoutAcct = null, journalStamp = null }) {
  const lot = `acct_lot_${bountyId}`;
  b.move({ kind: "escrow-lock", bountyId, from: posterAcct, to: lot, amount });
  b.move({ kind: "attribute", bountyId, from: lot, to: lot, amount, provenance: journalStamp });
  b.move({ kind: "approve", bountyId, from: lot, to: lot, amount });
  b.move({ kind: "payout", bountyId, from: lot, to: payoutAcct ?? claimantAcct, amount });
  if (fee) b.move({ kind: "fee", bountyId, from: claimantAcct, to: "acct_pool", amount: fee });
}

function kitchenSink({ boardExtraReview = false } = {}) {
  const b = new SnapshotBuilder();
  for (let i = 1; i <= 5; i++) b.roomEvent(`evt_${i}`);

  // 1. Paid via escrow-keeper release resolution; stamps at every placement.
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_keeper", claimant: "op_worker_a", state: "paid", rubric_version: 3, rubric_hash: "rh_k",
    submission_hash: "sh_keeper",
    evidence_json: json({ provenance: STAMP_SUBMIT }),
    resolution_json: json({ kind: "release", outcome: "release", settledBy: { id: "escrow-keeper" }, settledAt: T2, provenance: STAMP_VERDICT }),
  }));
  b.bountyEvent("bty_keeper", "claimed"); b.bountyEvent("bty_keeper", "submitted");
  paidLegs(b, { bountyId: "bty_keeper", posterAcct: "op_poster_a", claimantAcct: "op_worker_a", fee: 100, journalStamp: STAMP_JOURNAL });

  // 2. Paid with a verifier attestation carrying per-criterion citations.
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_attested", claimant: "op_worker_b", state: "paid", rubric_version: 2, rubric_hash: "rh_a",
    submission_hash: "sh_att",
    attestation_json: json({
      recordedBy: "op_verifier_a", recordedAt: T2, rubricVersion: 2, provenance: STAMP_VERDICT,
      citations: [{ criterionId: "c1", verdict: "pass" }, { criterionId: "c2", verdict: "fail" }],
    }),
  }));
  paidLegs(b, { bountyId: "bty_attested", posterAcct: "op_poster_a", claimantAcct: "op_worker_b" });

  // 3. Paid with NO verdict record anywhere: the substrate gap the
  // completeness measurement exists to name.
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_noverdict", claimant: "op_worker_b", state: "paid", submission_hash: "sh_nv",
  }));
  b.move({ kind: "escrow-lock", bountyId: "bty_noverdict", from: "op_poster_a", to: "acct_lot_bty_noverdict", amount: 4000 });
  b.move({ kind: "payout", bountyId: "bty_noverdict", from: "acct_lot_bty_noverdict", to: "op_worker_b", amount: 4000 });

  // 4. Two-identity ring: payout credits the funding account (SD-2).
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_ring", poster: "op_ring_a", claimant: "op_ring_b", state: "paid", submission_hash: "sh_ring",
    attestation_json: json({ recordedBy: "op_ring_a", recordedAt: T2 }),
  }));
  paidLegs(b, { bountyId: "bty_ring", posterAcct: "op_ring_a", claimantAcct: "op_ring_b", payoutAcct: "op_ring_a" });

  // 5. Same named party on both sides, funding from its own account (SD-1 + SD-3).
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_solo", poster: "op_solo", claimant: "op_solo", state: "paid", submission_hash: "sh_solo",
    attestation_json: json({ recordedBy: "op_solo", recordedAt: T2 }),
  }));
  paidLegs(b, { bountyId: "bty_solo", posterAcct: "op_solo", claimantAcct: "op_solo" });

  // 6. Dispute decided (split), then paid.
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_split", poster: "op_poster_d", claimant: "op_worker_c", state: "paid",
    dispute_id: "dsp_1", dispute_opened_ms: MS1, submission_hash: "sh_split",
    resolution_json: json({ kind: "split", outcome: "split", decidedBy: "op_decider", decidedAt: T2, reasonCodes: ["partial-delivery"] }),
  }));
  b.add("bounty_disputes", {
    dispute_id: "dsp_1", room_id: ROOM,
    body: json({ outcome: "split", reasonCodes: ["partial-delivery"], decider: "op_decider", openedAt: T1 }),
    updated_at: T2,
  });
  paidLegs(b, { bountyId: "bty_split", posterAcct: "op_poster_d", claimantAcct: "op_worker_c", amount: 2000 });

  // 7. The public-work mirror bounty: criteria text, NO rubric pin of
  // its own (the pin is the offer's terms_version, via the link row).
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_mirror", claimant: "op_worker_a", state: "paid", criteria: "Write docs well",
    rubric_hash: null, rubric_version: null, submission_hash: "artsha1",
    attestation_json: json({ recordedBy: "op_poster_a", recordedAt: T2 }),
  }));
  paidLegs(b, { bountyId: "bty_mirror", posterAcct: "op_poster_a", claimantAcct: "op_worker_a" });

  // 8. Refunded: a verdict row, but not a settled outcome.
  b.add("bounty_records", bountyRow({ bounty_id: "bty_refunded", claimant: "op_worker_a", state: "refunded" }));
  b.move({ kind: "escrow-lock", bountyId: "bty_refunded", from: "op_poster_a", to: "acct_lot_bty_refunded", amount: 4000 });
  b.move({ kind: "refund", bountyId: "bty_refunded", from: "acct_lot_bty_refunded", to: "op_poster_a", amount: 4000 });

  // 9. Proposed only: no claim, no verdict, no settlement.
  b.add("bounty_records", bountyRow({ bounty_id: "bty_proposed" }));

  // 10. Legacy paid bounty: attested, but written before stamps existed.
  b.add("bounty_records", bountyRow({
    bounty_id: "bty_legacy", claimant: "op_worker_b", state: "paid", submission_hash: "sh_leg",
    attestation_json: json({ recordedBy: "op_verifier_a", recordedAt: T2 }),
  }));
  paidLegs(b, { bountyId: "bty_legacy", posterAcct: "op_poster_a", claimantAcct: "op_worker_b" });

  // Public-work: offer + task + receipt + decision + settlement link.
  b.add("project_offers", {
    offer_id: "ofr_1", room_id: ROOM, owner_id: "op_poster_a", version: 1, revision: 1, status: "published",
    terms: json({
      schema: "project-offer-terms/1", title: "Write docs", summary: "Docs.",
      acceptanceCriteria: ["Write docs well"],
      reward: { kind: "work_trade", unit: "credit", amountMinor: "4000", decimals: 3 },
    }),
    private_links: "[]", created_at: MS1, updated_at: MS1,
  });
  b.add("public_work_tasks", {
    offer_id: "ofr_1", namespace_key: "ns1", room_id: ROOM, terms_version: 1,
    repository_url: "https://example.invalid/repo", repository_ref: "main", files_json: "[]",
    generation: 0, created_at: MS1,
  });
  b.add("public_work_receipts", {
    receipt_id: "pwr_1", offer_id: "ofr_1", namespace_key: "ns1", generation: 0,
    identity_id: "op_worker_a", artifact_text: "the docs", artifact_sha256: "artsha1", artifact_bytes: 8,
    receipt_json: json({
      schema: "public-work-receipt/1", receiptId: "pwr_1", taskId: "ofr_1", title: "Write docs",
      termsVersion: 1, namespaceId: "ns1", generation: 0, identityId: "op_worker_a",
      state: "submitted", provenance: STAMP_PW, artifact: { sha256: "artsha1", bytes: 8 },
      verification: "hash_only", createdAt: T1,
    }),
    created_at: MS1,
  });
  b.add("public_work_reviews", {
    receipt_id: "pwr_1", room_id: ROOM, revision: 1,
    state_json: json({
      decision: { decision: "accepted", actorId: "op_poster_a", reason: "good docs", at: T2, provenance: STAMP_PW },
      verification: { verdict: "verified", actorId: "op_poster_a", at: T2 },
    }),
  });
  b.add("public_work_settlements", {
    offer_id: "ofr_1", room_id: ROOM, bounty_id: "bty_mirror", poster_lane: "op_poster_a",
    claimant_lane: "op_worker_a", amount_millis: 4000, receipt_id: "pwr_1", created_at: MS1,
  });

  // Public-work: verification-only receipt under a second offer.
  b.add("project_offers", {
    offer_id: "ofr_2", room_id: ROOM, owner_id: "op_owner_b", version: 1, revision: 1, status: "published",
    terms: json({ schema: "project-offer-terms/1", title: "Fix bug", acceptanceCriteria: ["tests pass"] }),
    private_links: "[]", created_at: MS1, updated_at: MS1,
  });
  b.add("public_work_tasks", {
    offer_id: "ofr_2", namespace_key: "ns1", room_id: ROOM, terms_version: 1,
    repository_url: "https://example.invalid/repo", repository_ref: "main", files_json: "[]",
    generation: 0, created_at: MS1,
  });
  b.add("public_work_receipts", {
    receipt_id: "pwr_2", offer_id: "ofr_2", namespace_key: "ns1", generation: 0,
    identity_id: "op_worker_c", artifact_text: "patch", artifact_sha256: "artsha2", artifact_bytes: 5,
    receipt_json: json({
      schema: "public-work-receipt/1", receiptId: "pwr_2", taskId: "ofr_2", title: "Fix bug",
      termsVersion: 1, namespaceId: "ns1", generation: 0, identityId: "op_worker_c",
      state: "submitted", artifact: { sha256: "artsha2", bytes: 5 }, verification: "hash_only", createdAt: T1,
    }),
    created_at: MS1,
  });
  b.add("public_work_reviews", {
    receipt_id: "pwr_2", room_id: ROOM, revision: 1,
    state_json: json({
      verification: {
        verdict: "needs-work", actorId: "op_verifier_a", at: T2, reason: "tests failing",
        executedChecks: [{ name: "unit-tests", result: "fail" }], provenance: STAMP_PW2,
      },
    }),
  });
  // Orphaned review: no receipt row exists for it.
  b.add("public_work_reviews", {
    receipt_id: "pwr_ghost", room_id: ROOM, revision: 1,
    state_json: json({ decision: { decision: "accepted", actorId: "op_poster_a", at: T2 } }),
  });

  // Board claims.
  b.add("work_claims", {
    room_id: ROOM, claim_id: "wc_1", updated_at: MS1,
    item_json: json({
      id: "wc_1", title: "Fix the thing", state: "done", owner: "op_worker_b",
      claimedAt: T0, leaseExpiresAt: "2026-10-02T00:00:00.000Z", reviewPolicy: "peer",
      acceptanceCriteria: ["works"],
      reviews: [{ memberId: "op_rev1", verdict: "approve", summary: "ok", at: T1 }],
      verification: { state: "verified", by: "op_rev1", at: T2, executedChecks: [{ name: "ci", result: "pass" }] },
      delivery: { artifactSha256: "dhash", at: T1 },
      pullRequest: { url: "https://example.invalid/pr/1" },
    }),
  });
  const wc2 = { id: "wc_2", title: "Later work", state: "open" };
  if (boardExtraReview) wc2.reviews = [{ memberId: "op_rev1", verdict: "approve", summary: "late ok", at: T2 }];
  b.add("work_claims", { room_id: ROOM, claim_id: "wc_2", updated_at: MS1, item_json: json(wc2) });

  return b;
}

const byId = episodes => new Map(episodes.map(e => [e.episodeId, e]));

test("full assembly: episodes join task, claim, delivery, verdict, settlement, dispute", async () => {
  const { episodes, report } = await assembleWorkEpisodes({ source: kitchenSink().lines() });
  const eps = byId(episodes);
  assert.equal(episodes.length, 14);
  assert.equal(report.snapshot.verification, "full");
  assert.equal(report.journalChain.ok, true);
  assert.equal(report.journalChain.checked, 66);

  const keeper = eps.get("bounty:bty_keeper");
  assert.equal(keeper.verdicts[0].rowId, "bounty:bty_keeper:acceptance");
  assert.equal(keeper.verdicts[0].outcome, "release");
  assert.equal(keeper.verdicts[0].accepted, true);
  assert.equal(keeper.provenanceSource, "verdict");
  assert.equal(keeper.provenance.claimedModelVersion, "model-verdict");
  assert.equal(keeper.provenance.sessionInstanceId, STAMP_VERDICT.sessionInstanceId);
  assert.equal(keeper.settlement.payoutMillis, 4000);
  assert.equal(keeper.settlement.feeMillis, 100);
  assert.equal(keeper.settlement.netMillis, 3900);
  assert.equal(keeper.settlement.journalEntryIds.length, 10);
  assert.equal(keeper.claim.claimedAt, T1);
  assert.equal(keeper.delivery.submittedAt, T1);
  assert.equal(keeper.assembly.complete, true);
  assert.equal(keeper.retentionClass, "decision");

  const attested = eps.get("bounty:bty_attested");
  assert.equal(attested.verdicts[0].criteriaSummary, "c1:pass, c2:fail");
  assert.deepEqual(attested.verdicts[0].criteriaOutcomes, [
    { criterionId: "c1", verdict: "pass" }, { criterionId: "c2", verdict: "fail" },
  ]);
  assert.equal(attested.verdicts[0].verifierId, "op_verifier_a");

  const split = eps.get("bounty:bty_split");
  assert.equal(split.dispute.outcome, "split");
  assert.deepEqual(split.dispute.reasonCodes, ["partial-delivery"]);
  assert.equal(split.dispute.deciderRef, "op_decider");
  assert.equal(split.dispute.openedAt, T1);
  assert.equal(split.verdicts[0].accepted, true);

  const refunded = eps.get("bounty:bty_refunded");
  assert.equal(refunded.verdicts[0].outcome, "rejected");
  assert.equal(refunded.verdicts[0].accepted, false);

  const proposed = eps.get("bounty:bty_proposed");
  assert.equal(proposed.claim, null);
  assert.deepEqual(proposed.verdicts, []);
  assert.equal(proposed.settlement, null);

  const pw = eps.get("public-work:pwr_1");
  assert.equal(pw.verdicts.length, 1); // decision row beats verification row
  assert.equal(pw.verdicts[0].rowId, "public-work:pwr_1:acceptance");
  assert.equal(pw.verdicts[0].accepted, true);
  assert.equal(pw.settlement.bountyId, "bty_mirror");
  assert.equal(pw.settlement.payoutMillis, 4000);
  assert.equal(pw.provenanceSource, "submission");
  assert.equal(pw.provenance.claimedModelVersion, "model-pw");
  assert.equal(pw.task.rewardMillis, 4000);
  assert.equal(pw.claim.deliveryGeneration, 0);

  const pw2 = eps.get("public-work:pwr_2");
  assert.equal(pw2.verdicts[0].decisionKind, "verification");
  assert.equal(pw2.verdicts[0].outcome, "needs-work");
  assert.equal(pw2.verdicts[0].accepted, null);
  assert.deepEqual(pw2.verdicts[0].criteriaOutcomes, [{ name: "unit-tests", result: "fail" }]);
  assert.equal(pw2.provenanceSource, "verdict");
  assert.equal(pw2.settlement, null);

  const board = eps.get("board:wc_1");
  assert.equal(board.verdicts.length, 2);
  assert.equal(board.verdicts[1].decisionKind, "acceptance");
  assert.equal(board.verdicts[1].accepted, true);
  assert.equal(board.claim.leaseHours, 24);
  assert.equal(board.delivery.prUrl, "https://example.invalid/pr/1");
  assert.equal(board.assembly.complete, true);

  assert.ok(report.orphans.some(o => o.kind === "review" && o.id === "pwr_ghost"));
});

test("completeness: settled-bounty denominator, gaps named, mirror terms pin credited", async () => {
  const { episodes, report } = await assembleWorkEpisodes({ source: kitchenSink().lines() });
  const eps = byId(episodes);
  const bounty = report.surfaces.bounty;
  assert.equal(bounty.settled, 8);
  assert.equal(bounty.settledComplete, 7);
  assert.deepEqual(bounty.missingReasons, { verdict: 1 });
  assert.equal(bounty.mirrorTermsPinned, 1);
  assert.deepEqual(eps.get("bounty:bty_noverdict").assembly.missing, ["verdict"]);
  const mirror = eps.get("bounty:bty_mirror");
  assert.equal(mirror.task.criteriaHash, null);
  assert.equal(mirror.assembly.complete, true);
  assert.deepEqual([...eps.get("board:wc_2").assembly.missing].sort(), ["claimant", "delivery", "verdict"]);
});

test("provenance: legacy unstamped records assemble with nulls, never reconstructions", async () => {
  const { episodes } = await assembleWorkEpisodes({ source: kitchenSink().lines() });
  const legacy = byId(episodes).get("bounty:bty_legacy");
  assert.equal(legacy.provenanceSource, null);
  assert.deepEqual(legacy.provenance, {
    sessionInstanceId: null, authorizingPrincipalId: null,
    claimedModelVersion: null, claimedHarnessVersion: null, claimedEnvironment: null,
  });
  assert.equal(legacy.assembly.complete, true);
});

test("trigger counters (R3/B7): distinct operators, self-dealing excluded, non-fleet by roster", async () => {
  const lines = kitchenSink().lines();
  const noRoster = await assembleWorkEpisodes({ source: lines });
  const c = noRoster.report.triggerCounters;
  assert.equal(c.settledOutcomes, 8);
  assert.equal(c.verifiedSettledOutcomes, 7);
  assert.equal(c.selfDealingFlaggedAmongVerified, 2);
  assert.equal(c.verifiedExcludingSelfDealing, 5);
  assert.equal(c.distinctOperators, 3);
  assert.equal(c.distinctPosterOperators, 2);
  assert.equal(c.trigger.value, 3);
  assert.equal(c.trigger.fires, false);
  assert.equal(c.nonFleet.rosterSupplied, false);
  assert.equal(c.nonFleet.outcomesWithNonFleetParty, null);
  assert.equal(c.nonFleet.distinctNonFleetOperators, null);
  assert.equal(c.source, "computed");

  const eps = byId(noRoster.episodes);
  assert.deepEqual(eps.get("bounty:bty_ring").assembly.selfDealing, ["SD-2"]);
  assert.deepEqual([...eps.get("bounty:bty_solo").assembly.selfDealing].sort(), ["SD-1", "SD-2", "SD-3"]);

  const roster = ["op_poster_a", "op_worker_a", "op_worker_b", "op_poster_d", "op_verifier_a", "op_decider", "op_solo", "op_ring_a", "op_ring_b"];
  const withRoster = await assembleWorkEpisodes({ source: lines, fleetRoster: roster });
  assert.equal(withRoster.report.triggerCounters.nonFleet.rosterSupplied, true);
  assert.equal(withRoster.report.triggerCounters.nonFleet.outcomesWithNonFleetParty, 1);
  assert.equal(withRoster.report.triggerCounters.nonFleet.distinctNonFleetOperators, 1);
});

test("integrity: tampered rows, torn event logs, and missing trailers are refused", async () => {
  const lines = kitchenSink().lines();
  const tampered = lines.map(line => {
    const parsed = JSON.parse(line);
    if (parsed.table === "bounty_records" && parsed.row.bounty_id === "bty_keeper") parsed.row.amount_millis = 9999;
    return JSON.stringify(parsed);
  });
  await assert.rejects(assembleWorkEpisodes({ source: tampered }), /digest does not match/);

  const torn = lines.filter(line => !line.includes('"evt_3"'));
  await assert.rejects(assembleWorkEpisodes({ source: torn }), /torn/);

  await assert.rejects(assembleWorkEpisodes({ source: lines.slice(0, -1) }), /no trailer/);
});

test("integrity: a broken journal hash chain aborts unless explicitly allowed", async () => {
  const builder = kitchenSink();
  const journal = builder.tables.get("bounty_journal");
  const victim = journal.find(row => row.bounty_id === "bty_keeper" && row.kind === "payout" && row.amount > 0);
  victim.amount = 4500; // trailer digests recompute over the mutated row; the entry hash no longer does
  const lines = builder.lines();
  await assert.rejects(assembleWorkEpisodes({ source: lines }), /hash chain breaks/);
  const allowed = await assembleWorkEpisodes({ source: lines, allowChainBreak: true });
  assert.equal(allowed.report.journalChain.ok, false);
  assert.equal(allowed.report.journalChain.break.entryId, victim.entry_id);
});

test("incremental: unchanged surfaces carry, changed surfaces re-emit, counters carry verbatim", async () => {
  const roster = ["op_poster_a", "op_worker_a", "op_worker_b", "op_poster_d"];
  const run1 = await assembleWorkEpisodes({ source: kitchenSink().lines(), fleetRoster: roster });
  assert.equal(run1.episodes.length, 14);

  const run2 = await assembleWorkEpisodes({ source: kitchenSink().lines(), state: run1.nextState, fleetRoster: roster });
  assert.equal(run2.episodes.length, 0);
  assert.equal(run2.report.totals.carried, 14);
  assert.equal(run2.report.surfaces.bounty.changed, false);
  assert.equal(run2.report.triggerCounters.source, "carried");
  const { source: _s1, ...counters1 } = run1.report.triggerCounters;
  const { source: _s2, ...counters2 } = run2.report.triggerCounters;
  assert.deepEqual(counters2, counters1);

  const changedLines = kitchenSink({ boardExtraReview: true }).lines();
  const run3 = await assembleWorkEpisodes({ source: changedLines, state: run1.nextState, fleetRoster: roster });
  assert.deepEqual(run3.episodes.map(e => e.episodeId), ["board:wc_2"]);
  assert.equal(run3.episodes[0].verdicts.length, 1);
  assert.equal(run3.report.triggerCounters.source, "carried");

  // The incremental end-state equals a full run's end-state, hash for hash.
  const run4 = await assembleWorkEpisodes({ source: changedLines, fleetRoster: roster });
  assert.deepEqual(run3.nextState.episodes, run4.nextState.episodes);
});

test("stampOf and selfDealingRules units", () => {
  assert.equal(stampOf(null, undefined, {}), null);
  assert.equal(stampOf({ provenance: "junk" }), null);
  assert.equal(stampOf({ provenance: { sessionInstanceId: 42 } }), null);
  assert.equal(stampOf({ provenance: STAMP_SUBMIT }).claimedModelVersion, "model-submit");
  assert.equal(stampOf(STAMP_SUBMIT).authorizingPrincipalId, "op_poster_a");

  assert.deepEqual(selfDealingRules({ poster: "a", claimant: "a", legs: [] }), ["SD-1"]);
  assert.deepEqual(selfDealingRules({ poster: "a", claimant: "b", legs: [
    { kind: "escrow-lock", account_id: "a", amount: -100 },
    { kind: "payout", account_id: "a", amount: 100 },
  ] }), ["SD-2"]);
  assert.deepEqual(selfDealingRules({ poster: "p", claimant: "b", legs: [
    { kind: "escrow-lock", account_id: "b", amount: -100 },
  ] }), ["SD-3"]);
  assert.deepEqual(selfDealingRules({ poster: "p", claimant: "c", legs: [
    { kind: "escrow-lock", account_id: "p", amount: -100 },
    { kind: "payout", account_id: "c", amount: 100 },
  ] }), []);
});

test("bright-line producer (D-3): every episode carries contentClasses stamped from the surface it was assembled from", async () => {
  const { episodes } = await assembleWorkEpisodes({ source: kitchenSink().lines() });
  assert.ok(episodes.length > 0);
  const surfaces = new Set();
  for (const ep of episodes) {
    assert.deepEqual(ep.contentClasses, [ep.surface],
      `${ep.episodeId}: contentClasses must be the assembler's own surface stamp — the W4 anonymiser's B4/B9 checks read this field`);
    surfaces.add(ep.surface);
  }
  assert.deepEqual([...surfaces].sort(), ["board", "bounty", "public-work"],
    "the fixture exercises all three surfaces, so all three classes are produced");
});
