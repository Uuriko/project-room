// Tests for the claim-bonds P1 reputation projector.
//
// What these protect (test-audit authoring gate):
// 1. Contract: the P1 signal derivation faithfully implements
//    CLAIMBONDS-P1-SPEC-2026-10-05.md over work_claim.updated events —
//    claim_completed (+3) on done, claim_released (+1) on clean release,
//    claim_flaked (-6, existing weight) on lease expiry attributed to the
//    previous owner, claim_judged_bad (-10) only on changes_requested,
//    claim_hoarded (-4) posted at claim time when the lane already holds
//    >= HOARDING_CAP (5) open claims. Positions track open claims per lane;
//    null-lease claims count toward the cap; renewal keeps the position
//    open with no signal. Same events -> same signals, always (idempotent
//    replay), and the journal sync never double-writes.
// 2. Credible regressions: off-by-one on the hoarding cap (fires at 4, or
//    fails to fire at 5); a lease-less claim escaping the cap (the trivial
//    surcharge bypass); attributing a lease-expiry flake to the cleared
//    ownerId instead of previousOwnerId; closing a position on renew; a
//    reviewed "approve" verdict judged as bad; duplicate journal rows on a
//    re-sync; the open-claim count following a reassigned claim to the old
//    lane instead of the new one.
// 3. No existing coverage: new module, new table, new signal types.
// 4. No production seams: deriveClaimSignals is pure; sync/visibility tests
//    run against in-memory node:sqlite or caller-owned Maps.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  HOARDING_CAP,
  CLAIM_REPUTATION_SIGNAL_TYPES,
  deriveClaimSignals,
  ensureClaimReputationSchema,
  laneClaimBondVisibility,
  projectClaimReputation,
  syncClaimReputationJournal
} from "../server/claim-reputation.mjs";
import { BOUNTY_SIGNAL_WEIGHTS } from "../server/reputation.mjs";

const T0 = Date.parse("2026-10-04T00:00:00.000Z");

function row(seq, claimId, action, data = {}) {
  return {
    roomId: "muse-room",
    seq,
    atMs: T0 + seq * 60_000,
    data: { workClaim: claimId, action, claimState: "claimed", ownerId: "lane-a", ...data }
  };
}

function signalsFor(rows, type) {
  return deriveClaimSignals(rows).filter(s => s.type === type);
}

// --- weights vocabulary -------------------------------------------------

test("the four P1 signal types are registered with the spec's weights", () => {
  assert.equal(BOUNTY_SIGNAL_WEIGHTS.claim_completed, 3);
  assert.equal(BOUNTY_SIGNAL_WEIGHTS.claim_released, 1);
  assert.equal(BOUNTY_SIGNAL_WEIGHTS.claim_flaked, -6);
  assert.equal(BOUNTY_SIGNAL_WEIGHTS.claim_judged_bad, -10);
  assert.equal(BOUNTY_SIGNAL_WEIGHTS.claim_hoarded, -4);
  for (const t of CLAIM_REPUTATION_SIGNAL_TYPES) {
    assert.ok(Object.hasOwn(BOUNTY_SIGNAL_WEIGHTS, t), `${t} registered`);
  }
});

test("HOARDING_CAP is the spec-frozen 5", () => {
  assert.equal(HOARDING_CAP, 5);
});

// --- positive signals ----------------------------------------------------

test("done posts claim_completed to the owner and closes the position", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "state_changed", { claimState: "done" })
  ];
  const got = signalsFor(rows, "claim_completed");
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "lane-a");
  assert.equal(got[0].weight, 3);
  const again = signalsFor([...rows, row(3, "c1", "state_changed", { claimState: "done" })], "claim_completed");
  assert.equal(again.length, 1, "a second done on a closed position emits nothing");
});

test("clean release posts claim_released and closes the position", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "released", { claimState: "unclaimed", ownerId: null })
  ];
  const got = signalsFor(rows, "claim_released");
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "lane-a");
  assert.equal(got[0].weight, 1);
});

// --- flake / judged-bad signals ------------------------------------------

test("lease expiry posts claim_flaked to the previous owner", () => {
  const rows = [
    row(1, "c1", "claimed", { ownerId: "lane-a" }),
    row(2, "c1", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" })
  ];
  const got = signalsFor(rows, "claim_flaked");
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "lane-a", "previousOwnerId names the flaker, not the cleared ownerId");
  assert.equal(got[0].weight, -6);
});

test("lease expiry on an unobserved claim still emits the flake", () => {
  const rows = [row(1, "c1", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" })];
  const got = signalsFor(rows, "claim_flaked");
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "lane-a");
});

test("reviewed changes_requested posts claim_judged_bad and closes the position", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "reviewed", { verdict: "changes_requested" })
  ];
  const got = signalsFor(rows, "claim_judged_bad");
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "lane-a");
  assert.equal(got[0].weight, -10);
  // The position is closed: a later done emits nothing.
  const done = signalsFor([...rows, row(3, "c1", "state_changed", { claimState: "done" })], "claim_completed");
  assert.equal(done.length, 0);
});

test("other review verdicts are not judged bad", () => {
  for (const verdict of ["approve", "comment"]) {
    const rows = [
      row(1, "c1", "claimed"),
      row(2, "c1", "reviewed", { verdict })
    ];
    assert.equal(signalsFor(rows, "claim_judged_bad").length, 0, `verdict ${verdict}`);
    // The position stays open: a later done still completes.
    const done = signalsFor([...rows, row(3, "c1", "state_changed", { claimState: "done" })], "claim_completed");
    assert.equal(done.length, 1, `verdict ${verdict} keeps the position`);
  }
});

// --- hoarding surcharge ----------------------------------------------------

function burstRows(n, lane = "lane-a", idStart = 1) {
  return Array.from({ length: n }, (_, i) => row(idStart + i, `c${idStart + i}`, "claimed", { ownerId: lane }));
}

test("the surcharge fires when opening while >= HOARDING_CAP claims are open", () => {
  const hoarded = signalsFor(burstRows(6), "claim_hoarded");
  assert.equal(hoarded.length, 1, "exactly one surcharge on the 6th open claim");
  assert.equal(hoarded[0].agent, "lane-a");
  assert.equal(hoarded[0].weight, -4);
});

test("no surcharge when opening below the cap", () => {
  assert.equal(signalsFor(burstRows(5), "claim_hoarded").length, 0, "opening the 5th claim (4 open) is clean");
  assert.equal(signalsFor(burstRows(4), "claim_hoarded").length, 0, "opening the 4th claim is clean");
});

test("a lane that works through its queue pays nothing extra", () => {
  const rows = [
    ...burstRows(5),
    row(6, "c1", "state_changed", { claimState: "done" }),
    row(7, "c2", "state_changed", { claimState: "done" }),
    row(8, "c6", "claimed")
  ];
  assert.equal(signalsFor(rows, "claim_hoarded").length, 0, "two completions drop the open count below the cap");
  assert.equal(signalsFor(rows, "claim_completed").length, 2);
});

test("null-lease open claims count toward the hoarding cap", () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    row(i + 1, `c${i + 1}`, "claimed", { ownerId: "lane-a", leaseExpiresAt: null }));
  const hoarded = signalsFor(rows, "claim_hoarded");
  assert.equal(hoarded.length, 1, "leaseHours: null is not a surcharge bypass");
});

test("renewal keeps the position open with no signal", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "renewed"),
    row(3, "c1", "renewed")
  ];
  const all = deriveClaimSignals(rows);
  assert.equal(all.length, 0, "renewal is the correct escape hatch: no signal either way");
  const done = signalsFor([...rows, row(4, "c1", "state_changed", { claimState: "done" })], "claim_completed");
  assert.equal(done.length, 1, "renewed claims still complete");
});

test("reassignment moves the open position to the new lane", () => {
  const rows = [
    ...burstRows(4, "lane-a"),
    row(5, "c1", "reassigned", { ownerId: "lane-b" }),
    row(6, "c5", "claimed", { ownerId: "lane-b" }),
    row(7, "c6", "claimed", { ownerId: "lane-b" }),
    row(8, "c7", "claimed", { ownerId: "lane-b" }),
    row(9, "c8", "claimed", { ownerId: "lane-b" }),
    row(10, "c9", "claimed", { ownerId: "lane-b" })
  ];
  const hoarded = signalsFor(rows, "claim_hoarded").filter(s => s.agent === "lane-b");
  assert.equal(hoarded.length, 1, "lane-b holds c1 + c5..c8 (5 open) when c9 opens");
  assert.equal(signalsFor(rows, "claim_hoarded").filter(s => s.agent === "lane-a").length, 0);
});

// --- replay / determinism ---------------------------------------------------

test("replaying the same events yields byte-identical signals", () => {
  const rows = [
    row(1, "c1", "claimed"),
    ...burstRows(6, "lane-b").map((r, i) => ({ ...r, seq: 2 + i, atMs: T0 + (2 + i) * 60_000 })),
    row(20, "c1", "state_changed", { claimState: "done" }),
    row(21, "c2", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-b" })
  ];
  const first = deriveClaimSignals(rows);
  const second = deriveClaimSignals(structuredClone(rows));
  assert.deepEqual(second, first);
});

test("out-of-order signals never regress the reputation timeline", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "state_changed", { claimState: "done" }),
    // A stale lease_expiry for another claim, stamped EARLIER than the done
    // (arrives later in the fold). signalTyped must ignore it so the
    // timeline never moves backwards.
    { ...row(3, "c2", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" }), atMs: T0 }
  ];
  const { reputation } = projectClaimReputation(rows, { nowMs: T0 + 3 * 60_000 });
  assert.equal(reputation.get("lane-a").score, 3, "the late older flake does not apply");
  assert.equal(reputation.get("lane-a").updatedMs, T0 + 2 * 60_000);
});

// --- projection and visibility ----------------------------------------------

test("projectClaimReputation folds signals into scores", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "state_changed", { claimState: "done" }),
    row(3, "c2", "claimed"),
    row(4, "c2", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" })
  ];
  const { reputation, signals, openClaims } = projectClaimReputation(rows, { nowMs: T0 + 4 * 60_000 });
  assert.ok(Math.abs(reputation.get("lane-a").score - (-3)) < 1e-3, "claim_completed +3 (decayed 2 min), claim_flaked -6");
  assert.equal(signals.length, 2);
  assert.equal(openClaims.get("lane-a") ?? 0, 0, "no positions left open");
});

test("projectClaimReputation reports end-of-fold open counts per lane", () => {
  const { openClaims } = projectClaimReputation(burstRows(3, "lane-a", 1).concat(burstRows(2, "lane-b", 4)));
  assert.equal(openClaims.get("lane-a"), 3);
  assert.equal(openClaims.get("lane-b"), 2);
});

test("laneClaimBondVisibility returns the read-side listing annotation", () => {
  const projected = projectClaimReputation(burstRows(6, "lane-a"), { nowMs: T0 + 10 * 60_000 });
  const vis = laneClaimBondVisibility(projected, "lane-a", { nowMs: T0 + 10 * 60_000 });
  assert.equal(vis.agentId, "lane-a");
  assert.equal(vis.openClaims, 6);
  assert.equal(vis.atCap, true, "openClaims >= HOARDING_CAP");
});

test("laneClaimBondVisibility reports the band and score decayed to now", () => {
  const flakeRow = { ...row(1, "c1", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" }), atMs: T0 };
  const projected = projectClaimReputation([flakeRow]);
  const nowMs = T0 + 30 * 24 * 3600 * 1000; // exactly one 30d half-life after the flake
  const vis = laneClaimBondVisibility(projected, "lane-a", { nowMs });
  assert.equal(vis.band, "standard");
  assert.ok(Math.abs(vis.score - (-3)) < 1e-9, `score decayed to -3, got ${vis.score}`);
  assert.equal(vis.atCap, false);
  assert.equal(vis.openClaims, 0);
});

// --- journal sync ------------------------------------------------------------

function eventDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, id TEXT, body TEXT)");
  return db;
}

function insertEvent(db, roomId, seq, type, data, atMs) {
  const body = JSON.stringify({ type, at: new Date(atMs).toISOString(), data });
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, seq, `evt-${seq}`, body);
}

test("syncClaimReputationJournal writes signal rows and is idempotent", () => {
  const db = eventDb();
  insertEvent(db, "muse-room", 1, "work_claim.updated", { workClaim: "c1", action: "claimed", claimState: "claimed", ownerId: "lane-a" }, T0);
  insertEvent(db, "muse-room", 2, "work_claim.updated", { workClaim: "c1", action: "state_changed", claimState: "done", ownerId: "lane-a" }, T0 + 60_000);
  const first = syncClaimReputationJournal(db, { roomId: "muse-room" });
  assert.equal(first.eventsRead, 2);
  assert.equal(first.signalsDerived, 1);
  assert.equal(first.signalsWritten, 1);
  const row = db.prepare("SELECT claim_id AS claimId, kind, agent_id AS agentId, weight FROM claim_reputation_signals").get();
  assert.equal(row.claimId, "c1");
  assert.equal(row.kind, "claim_completed");
  assert.equal(row.agentId, "lane-a");
  assert.equal(row.weight, 3);
  const second = syncClaimReputationJournal(db, { roomId: "muse-room" });
  assert.equal(second.signalsWritten, 0, "re-sync changes nothing");
});

test("syncClaimReputationJournal scopes by room and ignores other event types", () => {
  const db = eventDb();
  insertEvent(db, "muse-room", 1, "work_claim.updated", { workClaim: "c1", action: "claimed", claimState: "claimed", ownerId: "lane-a" }, T0);
  insertEvent(db, "muse-room", 2, "work_claim.updated", { workClaim: "c1", action: "state_changed", claimState: "done", ownerId: "lane-a" }, T0 + 60_000);
  insertEvent(db, "other-room", 1, "work_claim.updated", { workClaim: "c2", action: "claimed", claimState: "claimed", ownerId: "lane-b" }, T0);
  insertEvent(db, "muse-room", 3, "message.posted", { body: "hello" }, T0 + 120_000);
  const res = syncClaimReputationJournal(db, { roomId: "muse-room" });
  assert.equal(res.eventsRead, 2);
  assert.equal(res.signalsWritten, 1);
});
