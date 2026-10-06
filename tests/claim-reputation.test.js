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

test("reviewed changes_requested posts claim_judged_bad and keeps the position open", () => {
  // QA 2026-10-05: the P1 spec's signal table pins "positions counted open
  // until done/released/expired", and server/work-claims.mjs keeps a claim
  // active after a review (review only records an attestation). Closing the
  // position on changes_requested meant a lane that reworked and marked done
  // after a review got judged_bad (-10) but never the +3 completion, and its
  // open-claim count undercounted during rework.
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "reviewed", { verdict: "changes_requested" })
  ];
  const got = signalsFor(rows, "claim_judged_bad");
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "lane-a");
  assert.equal(got[0].weight, -10);
  // The position stays open: a later done still pays claim_completed.
  const done = signalsFor([...rows, row(3, "c1", "state_changed", { claimState: "done" })], "claim_completed");
  assert.equal(done.length, 1, "done after changes_requested still completes");
  assert.equal(done[0].weight, 3, "the completion pays the spec's +3");
  const { openClaims } = projectClaimReputation(rows, { nowMs: T0 + 4 * 60_000 });
  assert.equal(openClaims.get("lane-a") ?? 0, 1, "judged-bad claim still counts as open");
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

// --- re-claim after a closed lifecycle (P1 re-claim position gap) -------------
// The fold's `seen` mark is ever-observed, so a re-claim of the same claimId
// after a closed lifecycle must open a fresh position via the settled mark;
// duplicate terminals after a close must still stay silent.

test("a re-claim after done opens a fresh position and prices both lifecycles", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "state_changed", { claimState: "done" }),
    row(3, "c1", "claimed"),
    row(4, "c1", "state_changed", { claimState: "done" })
  ];
  const got = signalsFor(rows, "claim_completed");
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(s => s.seq), [2, 4]);
});

test("a re-claim after release opens a fresh position", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "released", { claimState: "unclaimed", ownerId: null }),
    row(3, "c1", "claimed"),
    row(4, "c1", "state_changed", { claimState: "done" })
  ];
  assert.equal(signalsFor(rows, "claim_released").length, 1);
  const completed = signalsFor(rows, "claim_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].seq, 4);
});

test("a re-claim after lease expiry opens a fresh position", () => {
  const rows = [
    row(1, "c1", "claimed", { ownerId: "lane-a" }),
    row(2, "c1", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" }),
    row(3, "c1", "claimed", { ownerId: "lane-b" }),
    row(4, "c1", "state_changed", { claimState: "done", ownerId: "lane-b" })
  ];
  assert.equal(signalsFor(rows, "claim_flaked").length, 1);
  const completed = signalsFor(rows, "claim_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].agent, "lane-b");
});

test("reassignment of a settled claim opens a fresh position", () => {
  const rows = [
    row(1, "c1", "claimed", { ownerId: "lane-a" }),
    row(2, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" }),
    row(3, "c1", "reassigned", { ownerId: "lane-b" }),
    row(4, "c1", "state_changed", { claimState: "done", ownerId: "lane-b" })
  ];
  const completed = signalsFor(rows, "claim_completed");
  assert.equal(completed.length, 2);
  assert.equal(completed[1].agent, "lane-b");
});

test("duplicate terminals after a close stay silent (settled is not a re-open)", () => {
  const rows = [
    row(1, "c1", "claimed"),
    row(2, "c1", "state_changed", { claimState: "done" }),
    row(3, "c1", "state_changed", { claimState: "done" })
  ];
  assert.equal(signalsFor(rows, "claim_completed").length, 1);
});

// --- terminal-before-first-claim residual (RC-2026-10-05-156) ----------------
// A terminal event (done/released) seen before the observer's first claim
// event marks the claim observed but not settled, so a later claimed or
// reassigned event for the same ID stays blocked. The terminal closes a
// lifecycle the observer never saw open — it must mark settled so the next
// claim opens a fresh position. (muse-room seq 3319.)

test("done seen before the first claim does not block the later claim", () => {
  const rows = [
    row(1, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" }),
    row(2, "c1", "claimed", { ownerId: "lane-a" }),
    row(3, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" })
  ];
  const completed = signalsFor(rows, "claim_completed");
  assert.equal(completed.length, 2);
  assert.deepEqual(completed.map(s => s.seq), [1, 3]);
});

test("released seen before the first claim does not block the later claim", () => {
  const rows = [
    row(1, "c1", "released", { claimState: "unclaimed", ownerId: "lane-a" }),
    row(2, "c1", "claimed", { ownerId: "lane-a" }),
    row(3, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" })
  ];
  assert.equal(signalsFor(rows, "claim_released").length, 1);
  const completed = signalsFor(rows, "claim_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].seq, 3);
});

test("duplicate terminals after a mid-history terminal stay silent", () => {
  const rows = [
    row(1, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" }),
    row(2, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" })
  ];
  assert.equal(signalsFor(rows, "claim_completed").length, 1);
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

test("ensureClaimReputationSchema creates the journal table", () => {
  const db = new DatabaseSync(":memory:");
  ensureClaimReputationSchema(db);
  const cols = db.prepare("PRAGMA table_info(claim_reputation_signals)").all().map(c => c.name);
  assert.deepEqual(cols, ["id", "claim_id", "kind", "agent_id", "weight", "at", "room_id", "room_seq"]);
});

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

test("syncClaimReputationJournal keeps the same claimId in two rooms separate (all-room sync)", () => {
  const db = eventDb();
  // Same claimId and same seq numbers in two rooms, different owners.
  for (const [room, lane] of [["room-a", "lane-a"], ["room-b", "lane-b"]]) {
    insertEvent(db, room, 1, "work_claim.updated", { workClaim: "c1", action: "claimed", claimState: "claimed", ownerId: lane }, T0);
    insertEvent(db, room, 2, "work_claim.updated", { workClaim: "c1", action: "state_changed", claimState: "done", ownerId: lane }, T0 + 60_000);
  }
  const res = syncClaimReputationJournal(db, {});
  assert.equal(res.signalsDerived, 2);
  assert.equal(res.signalsWritten, 2, "both rooms keep their own completion signal");
  const rows = db.prepare("SELECT room_id AS roomId, agent_id AS agentId, id FROM claim_reputation_signals ORDER BY room_id").all();
  assert.deepEqual(rows.map(r => [r.roomId, r.agentId]), [["room-a", "lane-a"], ["room-b", "lane-b"]]);
  assert.notEqual(rows[0].id, rows[1].id, "signal IDs differ across rooms");
  assert.equal(syncClaimReputationJournal(db, {}).signalsWritten, 0, "re-sync is idempotent");
});

test("syncClaimReputationJournal rebuilds legacy-format rows, including misattributed ones", () => {
  const db = eventDb();
  // Same claim/type/seq in two rooms: the old mixed fold stamped both with one room.
  for (const [room, lane] of [["room-a", "lane-a"], ["room-b", "lane-b"]]) {
    insertEvent(db, room, 1, "work_claim.updated", { workClaim: "c1", action: "claimed", claimState: "claimed", ownerId: lane }, T0);
    insertEvent(db, room, 2, "work_claim.updated", { workClaim: "c1", action: "state_changed", claimState: "done", ownerId: lane }, T0 + 60_000);
  }
  ensureClaimReputationSchema(db);
  // Old-code output: one legacy row (room-b's signal stamped room-a, lane-b).
  db.prepare("INSERT INTO claim_reputation_signals (id, claim_id, kind, agent_id, weight, at, room_id, room_seq) VALUES (?,?,?,?,?,?,?,?)")
    .run("claimrep:c1:claim_completed:2", "c1", "claim_completed", "lane-b", 3, T0 + 60_000, "room-a", 2);
  const res = syncClaimReputationJournal(db, {});
  assert.equal(res.legacyRowsRemoved, 1);
  assert.equal(res.signalsWritten, 2);
  const rows = db.prepare("SELECT id, room_id AS roomId, agent_id AS agentId FROM claim_reputation_signals ORDER BY room_id").all();
  assert.deepEqual(rows.map(r => [r.id, r.roomId, r.agentId]), [
    ["claimrep:room-a:c1:claim_completed:2", "room-a", "lane-a"],
    ["claimrep:room-b:c1:claim_completed:2", "room-b", "lane-b"]
  ], "misattributed legacy row is gone; each room has its own correct row");
  const again = syncClaimReputationJournal(db, {});
  assert.equal(again.signalsWritten, 0);
  assert.equal(again.legacyRowsRemoved, 0);
});

test("scoped sync with any legacy row (even one stamped to a different room) forces a full rebuild", () => {
  const db = eventDb();
  for (const [room, lane] of [["room-a", "lane-a"], ["room-b", "lane-b"]]) {
    insertEvent(db, room, 1, "work_claim.updated", { workClaim: "c1", action: "claimed", claimState: "claimed", ownerId: lane }, T0);
    insertEvent(db, room, 2, "work_claim.updated", { workClaim: "c1", action: "state_changed", claimState: "done", ownerId: lane }, T0 + 60_000);
  }
  ensureClaimReputationSchema(db);
  // Old-code row stamped to a non-null room (room-b) that is NOT the room
  // being synced (room-a); a v3 scoped sync would have left it behind.
  db.prepare("INSERT INTO claim_reputation_signals (id, claim_id, kind, agent_id, weight, at, room_id, room_seq) VALUES (?,?,?,?,?,?,?,?)")
    .run("claimrep:c1:claim_completed:2", "c1", "claim_completed", "lane-b", 3, T0 + 60_000, "room-b", 2);
  const res = syncClaimReputationJournal(db, { roomId: "room-a" });
  assert.equal(res.legacyRowsRemoved, 1);
  assert.equal(res.widenedToAllRooms, true);
  const rows = db.prepare("SELECT id, room_id AS roomId, agent_id AS agentId FROM claim_reputation_signals ORDER BY room_id").all();
  assert.deepEqual(rows.map(r => [r.id, r.agentId]), [
    ["claimrep:room-a:c1:claim_completed:2", "lane-a"],
    ["claimrep:room-b:c1:claim_completed:2", "lane-b"]
  ], "no surviving legacy duplicate; both rooms rebuilt");
  const again = syncClaimReputationJournal(db, { roomId: "room-a" });
  assert.equal(again.widenedToAllRooms, false);
  assert.equal(again.legacyRowsRemoved, 0);
  assert.equal(again.signalsWritten, 0);
});

test("all-room sync: one lane spanning two rooms gets no false hoarded signal and per-room rows", () => {
  const db = eventDb();
  let seq = 0;
  // lane-a holds 3 open claims in each room: 6 across rooms, never 5 in one room.
  for (const room of ["room-a", "room-b"]) {
    for (const id of ["x1", "x2", "x3"]) {
      seq += 1;
      insertEvent(db, room, seq, "work_claim.updated", { workClaim: id, action: "claimed", claimState: "claimed", ownerId: "lane-a" }, T0 + seq * 1000);
    }
  }
  for (const room of ["room-a", "room-b"]) {
    seq += 1;
    insertEvent(db, room, seq, "work_claim.updated", { workClaim: "x1", action: "state_changed", claimState: "done", ownerId: "lane-a" }, T0 + seq * 1000);
  }
  const res = syncClaimReputationJournal(db, {});
  const kinds = db.prepare("SELECT kind FROM claim_reputation_signals").all().map(r => r.kind);
  assert.ok(!kinds.includes("claim_hoarded"), "cap is per room, not summed across rooms");
  const completed = db.prepare("SELECT room_id AS roomId FROM claim_reputation_signals WHERE kind='claim_completed' ORDER BY room_id").all();
  assert.deepEqual(completed.map(r => r.roomId), ["room-a", "room-b"], "same claimId x1 persists once per room");
  assert.equal(res.signalsWritten, 2);
});
