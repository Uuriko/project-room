// SEED-GROWN — production-shaped volume and history for QA-J5/J6, X1/X2
// and A1: a ~2,200-task board across every lifecycle state, an escrow
// room whose settled history follows the production census proportions
// (EXP-T4 strata A/B/C: clean accepts, not-accepteds, dispute-settled,
// self-attested board completions, verdict-less public deliveries), aged
// receipts, several operators, and one archive room filled to just under
// the app's 4 MiB projection guard. Proportions are the census's; every unit is synthetic and
// driven through the real doors.
import { join } from "node:path";
import {
  DAY_MS, SeedClock, openSeedWorld, postBulkMessage, fillerText,
  postBounty, fundClaimSubmit, acceptBounty, disputeBounty, decideDispute, keeperSettle,
  driveWorkClaim, publishRoom, seedOffer, claimAndFinishOffer, reviewOfferReceipt,
  measureRoom, writePackFiles, baseManifest, seedLog,
} from "./common.mjs";
import { createWork, claimWork, updateWork, closeStaleUnclaimed, releaseExpired } from "../../../server/work-claims.mjs";
import { progressEscrowEpochs } from "../../../server/bounty-epoch-keeper.mjs";
import { queryPublicReceipts, noteWorkClaimChange } from "../../../server/public-read-model.mjs";

const ROLES = [
  { role: "owner", displayName: "Seed Grown Owner", profile: null },
  { role: "poster", displayName: "Seed Grown Poster", profile: "collaborate" },
  { role: "poster-2", displayName: "Seed Grown Poster Two", profile: "collaborate" },
  { role: "worker-1", displayName: "Seed Grown Worker One", profile: "contribute" },
  { role: "worker-2", displayName: "Seed Grown Worker Two", profile: "contribute" },
  { role: "worker-3", displayName: "Seed Grown Worker Three", profile: "contribute" },
  { role: "verifier", displayName: "Seed Grown Verifier", profile: "review" },
  { role: "decider", displayName: "Seed Grown Decider", profile: "collaborate" },
  // Dedicated bad-outcome lanes: an upheld dispute or a rejected delivery
  // records a flake strike on the claimant, and the anti-flake ladder
  // (server/bounty-escrow.mjs slice 8) cools a lane down for 7 days at 3
  // strikes — so the 12 bad-outcome units are spread 3-per-lane over four
  // lanes that claim nothing else, exactly as a real room's repeat
  // offenders would be distinct lanes.
  { role: "flake-1", displayName: "Seed Grown Flake Worker One", profile: "contribute" },
  { role: "flake-2", displayName: "Seed Grown Flake Worker Two", profile: "contribute" },
  { role: "flake-3", displayName: "Seed Grown Flake Worker Three", profile: "contribute" },
  { role: "flake-4", displayName: "Seed Grown Flake Worker Four", profile: "contribute" },
];
// Sized so a pure-spender poster's peak exposure (paid-out plus locked
// across the phase) stays inside the 100-credit genesis endowment:
// ~9 funded units per poster at an 8-credit average.
const AMOUNTS = [4, 6, 8, 10, 12];

export async function buildGrown(outDir, { appSha, bulkTargetBytes } = {}) {
  const clock = new SeedClock();
  const world = await openSeedWorld(join(outDir, "room.sqlite"), clock);
  const { store } = world;
  const esc = store.bountyEscrow;
  const identities = [];
  let manifest;
  let credentials;
  try {
    const byRole = {};
    for (const spec of ROLES) {
      const identity = await world.mint(spec.displayName);
      byRole[spec.role] = { ...identity, ...spec };
      identities.push({ role: spec.role, displayName: spec.displayName, identityId: identity.identityId });
    }
    const id = role => byRole[role].identityId;
    const workers = [id("worker-1"), id("worker-2"), id("worker-3")];
    // The settled-history worker rotation follows the census shape: one
    // dominant worker (~55%), then two smaller shares.
    const workerFor = i => (i % 20 < 11 ? workers[0] : i % 20 < 17 ? workers[1] : workers[2]);
    const posters = [id("poster"), id("poster-2"), id("owner"), workers[0], workers[1], workers[2]];

    const board = await world.createRoom(byRole.owner, {
      title: "Seed Grown — board",
      purpose: "QA seed pack: a production-shaped 2,200-task board in every lifecycle state.",
    });
    for (const role of ["poster", "poster-2", "worker-1", "worker-2", "worker-3", "verifier"]) {
      await world.joinRoom(byRole.owner, board, byRole[role], byRole[role].profile);
    }
    const escrowRoom = await world.createRoom(byRole.owner, {
      title: "Seed Grown — escrow history",
      purpose: "QA seed pack: settled/disputed bounty history in census proportions, plus public work.",
    });
    for (const spec of ROLES.slice(1)) await world.joinRoom(byRole.owner, escrowRoom, byRole[spec.role], spec.profile);
    esc.ensureGenesis(escrowRoom);
    const archive = await world.createRoom(byRole.owner, {
      title: "Seed Grown — archive",
      purpose: "QA seed pack: an archive room filled to just under the app's 4 MiB projection guard.",
    });
    for (const role of ["worker-1", "verifier", "decider"]) {
      await world.joinRoom(byRole.owner, archive, byRole[role], byRole[role].profile);
    }
    esc.ensureGenesis(archive);

    // ---------------------------------------------------------- board --
    // Phase A: 30 unclaimed tasks seeded at the epoch go dormant and the
    // stale sweep closes them; 60 more are seeded 19 days later, far too
    // fresh for the sweep, and stay unclaimed.
    for (let i = 0; i < 30; i += 1) {
      const item = createWork({ id: `grown-a-${String(i).padStart(3, "0")}`, title: `Grown board task A-${i}` },
        { now: clock.t, agentId: id("poster") });
      store.workClaims.set(board, item);
    }
    clock.advance(19 * DAY_MS);
    for (let i = 30; i < 90; i += 1) {
      const item = createWork({ id: `grown-a-${String(i).padStart(3, "0")}`, title: `Grown board task A-${i}` },
        { now: clock.t, agentId: id("poster") });
      store.workClaims.set(board, item);
    }
    clock.advance(1 * DAY_MS);
    const closable = store.workClaims.list(board);
    for (const [, closed] of closeStaleUnclaimed(closable, clock.t, { limit: 30 })) {
      store.workClaims.set(board, closed);
    }

    // Phase B: the remaining 2,080 tasks in batches of 80, the clock
    // stepping 6 hours per batch so history ages across the window.
    const plan = [
      ...Array(1150).fill("done-self"),
      ...Array(260).fill("done-verified"),
      ...Array(120).fill("delivered"),
      ...Array(180).fill("in_progress"),
      ...Array(90).fill("claimed"),
      ...Array(40).fill("blocked"),
      ...Array(240).fill("unclaimed"),
    ];
    let twoCycle = 0;
    for (let i = 0; i < plan.length; i += 1) {
      if (i > 0 && i % 80 === 0) clock.advance(6 * 3_600_000);
      const path = plan[i];
      const claimId = `grown-b-${String(i).padStart(4, "0")}`;
      const worker = workerFor(i);
      if (path === "done-self" && twoCycle < 40) {
        // Two-cycle texture: claimed, lease released by the real expiry
        // path, re-claimed by another worker, then finished.
        twoCycle += 1;
        let item = createWork({ id: claimId, title: `Grown board task B-${i}`, reviewPolicy: "self_attested", acceptanceCriteria: ["criterion-1"] },
          { now: clock.t, agentId: id("poster") });
        item = claimWork(item, worker, { now: clock.t, leaseHours: 1 });
        clock.advance(2 * 3_600_000);
        [item] = releaseExpired([item], clock.t);
        item = claimWork(item, workerFor(i + 7), { now: clock.t, leaseHours: 24 });
        item = updateWork(item, workerFor(i + 7), { state: "in_progress", now: clock.t });
        item = updateWork(item, workerFor(i + 7), {
          state: "delivered", now: clock.t,
          delivery: {
            artifact: { kind: "text", ref: `room://artifacts/${claimId}`, sha256: "0".repeat(63) + "1" },
            checks: [{ name: "self-check", result: "pass" }], criteria: [{ criterion: "criterion-1", status: "met" }],
          },
        });
        item = updateWork(item, workerFor(i + 7), { state: "done", note: "Finished on the second claim.", now: clock.t });
        store.workClaims.set(board, item);
        continue;
      }
      driveWorkClaim(store, clock, board, {
        id: claimId, title: `Grown board task B-${i}`,
        creator: id("poster"), worker, reviewer: id("verifier"), path,
        leaseHours: 24,
      });
    }

    seedLog("grown", "board done");
    // -------------------------------------------------------- archive --
    // Built before the escrow history so this room's keeper settle (which
    // is store-wide) runs while the escrow room still holds no bounties
    // whose resting states it would disturb.
    let archivePosted = 0;
    let archiveBodyBytes = 44_000;
    const archiveTarget = bulkTargetBytes ?? 3_900_000;
    const archiveProjection = () => store.db.prepare("SELECT LENGTH(projection) AS n FROM rooms WHERE id=?").get(archive).n;
    while (archiveProjection() < archiveTarget) {
      try {
        postBulkMessage(store, clock, archive, id("owner"), `arch-${archivePosted}`, fillerText(`seed grown archive ${archivePosted}`, archiveBodyBytes));
        archivePosted += 1;
      } catch {
        archiveBodyBytes = Math.floor(archiveBodyBytes / 2);
        if (archiveBodyBytes < 1_000) throw new Error("archive: message bodies refused below 1 KB");
      }
    }
    driveWorkClaim(store, clock, archive, {
      id: "archive-done", title: "Archived room finished task",
      creator: id("owner"), worker: id("worker-1"), path: "done-self",
    });
    {
      const bounty = postBounty(esc, clock, archive, { poster: id("owner"), title: "archive-settled", amount: 8, decider: id("decider") });
      fundClaimSubmit(esc, archive, bounty.bountyId, { poster: id("owner"), worker: id("worker-1"), evidenceTag: bounty.bountyId });
      acceptBounty(esc, clock, archive, bounty.bountyId, { poster: id("owner") });
      clock.advance(4 * DAY_MS);
      keeperSettle(store, clock);
    }

    seedLog("grown", "archive done");
    // --------------------------------------------------------- escrow --
    const posterFor = i => posters[i % posters.length];
    const amountFor = i => AMOUNTS[i % AMOUNTS.length];
    let bountyIndex = 0;
    let badIndex = 0;
    const driveAccepted = ({ disputed = null, rejected = false } = {}) => {
      const i = bountyIndex++;
      const poster = posterFor(i);
      let worker = workerFor(i);
      if (worker === poster) worker = workers[(i + 1) % workers.length];
      // Bad outcomes strike the claimant's flake ladder; route them to the
      // dedicated flake lanes (see ROLES) so the settled-history workers
      // stay claimable for the rest of the phase. They are also small
      // bounties: an upheld dispute drops the claimant's reputation score
      // into the probation band, whose lanes may only claim bounties up
      // to 5 credits (server/bounty-reputation.mjs) — a repeat offender's
      // world really is small bounties.
      const bad = rejected || disputed === "upheld";
      const amount = bad ? 4 : amountFor(i);
      if (bad) {
        worker = id(`flake-${(badIndex % 4) + 1}`);
        badIndex += 1;
      }
      const bounty = postBounty(esc, clock, escrowRoom, {
        poster, title: `grown-bounty-${i}`, amount, decider: id("decider"),
      });
      fundClaimSubmit(esc, escrowRoom, bounty.bountyId, { poster, worker, evidenceTag: bounty.bountyId });
      if (rejected) {
        esc.rejectWork(escrowRoom, bounty.bountyId, { rejector: poster, reason: "Does not meet the criteria." });
        return bounty;
      }
      acceptBounty(esc, clock, escrowRoom, bounty.bountyId, { poster });
      if (disputed) {
        disputeBounty(esc, escrowRoom, bounty.bountyId, { challenger: poster, amount });
        if (disputed !== "open") {
          decideDispute(esc, escrowRoom, bounty.bountyId, {
            decider: id("decider"), outcome: disputed,
            reasonCodes: disputed === "upheld" ? ["criterion-unmet"] : ["frivolous"],
          });
        }
      }
      return bounty;
    };
    // Census proportions (stratum A x2): 24 clean accepts, 12 not-accepted
    // (6 rejected deliveries, 6 dispute-refunded), 8 dispute-settled.
    for (let k = 0; k < 16; k += 1) driveAccepted();
    clock.advance(4 * DAY_MS);
    keeperSettle(store, clock); // the 16 clean accepts pay out
    for (let k = 0; k < 8; k += 1) driveAccepted({ disputed: "rejected" });
    clock.advance(4 * DAY_MS);
    keeperSettle(store, clock); // dispute-settled legs pay out
    for (let k = 0; k < 6; k += 1) driveAccepted({ disputed: "upheld" });
    for (let k = 0; k < 6; k += 1) driveAccepted({ rejected: true });
    for (let k = 0; k < 4; k += 1) driveAccepted();
    clock.advance(4 * DAY_MS);
    progressEscrowEpochs(store, { now: clock.t, escrow: esc }); // approves these 4; no second pass, so they rest at approved
    for (let k = 0; k < 4; k += 1) driveAccepted(); // accepted, challenge window still open
    for (let k = 0; k < 1; k += 1) driveAccepted({ disputed: "open" });
    // Live, unsettled states.
    for (let k = 0; k < 3; k += 1) { const i = bountyIndex++; postBounty(esc, clock, escrowRoom, { poster: posterFor(i), title: `grown-bounty-${i}`, amount: amountFor(i), decider: id("decider") }); }
    for (let k = 0; k < 4; k += 1) {
      const i = bountyIndex++;
      const bounty = postBounty(esc, clock, escrowRoom, { poster: posterFor(i), title: `grown-bounty-${i}`, amount: amountFor(i), decider: id("decider") });
      esc.fundBounty(escrowRoom, bounty.bountyId, { funder: posterFor(i) });
      if (k >= 2) esc.claimBounty(escrowRoom, bounty.bountyId, { claimant: workerFor(i) === posterFor(i) ? workers[(i + 1) % 3] : workerFor(i) });
      if (k >= 3) {
        const claimant = esc.getBounty(escrowRoom, bounty.bountyId).claimant;
        esc.submitWork(escrowRoom, bounty.bountyId, { claimant, evidence: { evidenceUrl: `https://example.invalid/evidence/${bounty.bountyId}`, summary: "Delivered" } });
      }
    }

    // Board claims inside the escrow room (these project the room's
    // public receipts once it is published below).
    for (let i = 0; i < 20; i += 1) {
      driveWorkClaim(store, clock, escrowRoom, {
        id: `grown-escrow-claim-${String(i).padStart(2, "0")}`, title: `Grown escrow-room task ${i}`,
        creator: id("poster"), worker: workerFor(i), reviewer: id("verifier"),
        path: i < 12 ? "done-verified" : "done-self",
      });
    }

    seedLog("grown", "escrow done");
    // ------------------------------------------- public work (stratum C) --
    const offers = [];
    for (let i = 0; i < 8; i += 1) {
      const offerId = `grown-pw-${i + 1}`;
      seedOffer(store, escrowRoom, {
        ownerId: id("owner"), offerId, title: `Grown public task ${i + 1}`, reviewerMemberIds: [id("verifier")],
      });
      const worker = [byRole["worker-1"], byRole["worker-2"], byRole["worker-3"]][i % 3];
      const { receipt, claimed } = claimAndFinishOffer(store, offerId, {
        workerSecret: worker.secret, artifactText: `The repository began as a sketch (${i + 1}).\n`,
      });
      offers.push({ offerId, receipt, generation: claimed.task.claim.generation });
    }
    reviewOfferReceipt(store, escrowRoom, {
      reviewerId: id("verifier"), offerId: offers[5].offerId, receipt: offers[5].receipt,
      generation: offers[5].generation, verdict: "PASS", decision: "accepted", tag: "grown-pw-6",
    });
    reviewOfferReceipt(store, escrowRoom, {
      reviewerId: id("verifier"), offerId: offers[6].offerId, receipt: offers[6].receipt,
      generation: offers[6].generation, verdict: "PASS", decision: "accepted", tag: "grown-pw-7",
    });
    reviewOfferReceipt(store, escrowRoom, {
      reviewerId: id("verifier"), offerId: offers[7].offerId, receipt: offers[7].receipt,
      generation: offers[7].generation, verdict: "PASS", decision: "rejected", tag: "grown-pw-8",
    });

    // Publish the escrow room and project its claim receipts.
    publishRoom(store, escrowRoom, id("owner"));
    noteWorkClaimChange(store, escrowRoom);

    // --------------------------------------------------------- measure --
    const publicAll = queryPublicReceipts(store, { limit: 50 });
    const receiptsBySource = {};
    const receiptsByState = {};
    for (const receipt of publicAll.receipts ?? []) {
      receiptsBySource[receipt.source] = (receiptsBySource[receipt.source] ?? 0) + 1;
      const state = receipt.verificationState ?? receipt.state ?? "unknown";
      receiptsByState[state] = (receiptsByState[state] ?? 0) + 1;
    }
    const claimedExpired = (store.workClaims.list(board)).filter(item =>
      item.state === "claimed" && item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) < clock.t).length;
    const conservation = esc.verifyConservation(escrowRoom);
    manifest = baseManifest("grown", clock, {
      appSha,
      consumers: ["QA-J5", "QA-J6", "QA-X1", "QA-X2", "QA-A1"],
      invariants: [
        "the board holds ~2,200 seeded claims with every lifecycle state present, including 30 sweep-closed and lease-expired claimed rows",
        "the escrow room's bounty states follow the census strata (paid / approved / accepted / disputed / refunded mix) and conservation verifies",
        "the published escrow room projects >= 24 public receipts across public-work and work-claim sources, incl. verified and rejected",
        "the archive room's stored projection is bulk-filled to just under the app's 4 MiB projection guard (shipped pack: >= 3.9 MB; measured bytes in contents)",
      ],
      notes: [
        "Strata proportions follow EXP-T4's production census (hunt-2026-10-18/exp-t4-directory-truth.md): stratum A 12:6:4 scaled x2, stratum B self-attested board volume dominant, stratum C verdict-less public deliveries.",
        "The board room deliberately does not publish receipts (production-shaped: its receipts stay in-room); the escrow room is the published one.",
        "The 12 bad-outcome escrow units (upheld disputes, rejected deliveries) are worked by four dedicated flake lanes at three strikes each, on 4-credit bounties — the anti-flake ladder's 7-day cooldown at 3 strikes and the probation reputation band's 5-credit claim cap are real product behaviour the build must respect, and a census-shaped room's repeat offenders are distinct lanes working small bounties.",
      ],
    });
    manifest.identities = identities;
    manifest.rooms = [
      { key: "board", roomId: board, title: "Seed Grown — board" },
      { key: "escrow", roomId: escrowRoom, title: "Seed Grown — escrow history" },
      { key: "archive", roomId: archive, title: "Seed Grown — archive" },
    ];
    manifest.contents = {
      board: { ...measureRoom(store, board), claimedWithExpiredLease: claimedExpired, twoCycleDone: twoCycle },
      escrow: { ...measureRoom(store, escrowRoom), conservationOk: conservation.ok === true },
      archive: { ...measureRoom(store, archive), bulkMessages: archivePosted, bulkBodyBytes: archiveBodyBytes },
      publicReceipts: { total: (publicAll.receipts ?? []).length, bySource: receiptsBySource, byState: receiptsByState },
    };
    credentials = { pack: "grown", identities: ROLES.map(spec => ({
      role: spec.role, identityId: byRole[spec.role].identityId, secret: byRole[spec.role].secret,
    })) };
  } finally {
    await world.close();
  }
  writePackFiles(outDir, manifest, credentials);
  return manifest;
}
