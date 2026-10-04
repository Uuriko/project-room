// Tests for the claim-bonds P0 shadow observer.
//
// What these protect (test-audit authoring gate):
// 1. Contract: the shadow journal faithfully implements the spec §2 bond
//    lifecycle over work_claim.updated events — lock at claim, release on
//    done / clean release, forfeit + flake strike on lease expiry /
//    judged-bad, carry on reassign, nothing on renew. Would-have entries
//    only: a release/forfeit is never written without an open shadow bond.
// 2. Credible regressions: forfeiting on a clean owner release, attributing
//    a lease-expiry flake to the wrong lane (ownerId is cleared on
//    auto-release; previousOwnerId names the flaker), duplicating entries
//    on a re-run, or writing phantom entries for claims first seen mid-
//    history without an open bond.
// 3. No existing coverage: new module, new table.
// 4. No production seams: deriveShadowEntries is pure; sync/report tests
//    run against an in-memory node:sqlite database.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  SHADOW_BOND_MILLIS,
  deriveShadowEntries,
  ensureShadowSchema,
  shadowReport,
  syncShadowJournal
} from "../server/analytics/claim-bond-shadow.mjs";

const T0 = Date.parse("2026-10-04T00:00:00.000Z");

function row(seq, claimId, action, data = {}) {
  return {
    roomId: "muse-room",
    seq,
    atMs: T0 + seq * 60_000,
    data: { workClaim: claimId, action, claimState: "claimed", ownerId: "lane-a", ...data }
  };
}

function kinds(entries) {
  return entries.map(e => e.kind);
}

test("claimed locks a shadow bond at the nominal amount", () => {
  const entries = deriveShadowEntries([row(1, "c1", "claimed")]);
  assert.deepEqual(kinds(entries), ["bond-locked"]);
  assert.equal(entries[0].ownerId, "lane-a");
  assert.equal(entries[0].amountMillis, SHADOW_BOND_MILLIS);
  assert.equal(entries[0].reason, "claimed");
});

test("done releases the open bond", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed"),
    row(2, "c1", "state_changed", { claimState: "done" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "bond-released"]);
  assert.equal(entries[1].reason, "done");
});

test("clean owner release returns the bond with no flake", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed"),
    row(2, "c1", "released", { claimState: "unclaimed", ownerId: null })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "bond-released"]);
  assert.equal(entries[1].reason, "owner_released");
  assert.ok(!entries.some(e => e.kind === "flake-recorded"), "an honest early release is not a flake");
});

test("lease expiry forfeits and attributes the flake to the previous owner", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed", { ownerId: "lane-a" }),
    row(2, "c1", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-a" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "flake-recorded", "bond-forfeited"]);
  const flake = entries.find(e => e.kind === "flake-recorded");
  assert.equal(flake.ownerId, "lane-a");
  assert.equal(flake.bondPosted, 1);
  assert.equal(flake.reason, "lease_expired");
});

test("judged-bad review forfeits the bond and records a flake", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed"),
    row(2, "c1", "reviewed", { verdict: "changes_requested", summary: "junk" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "flake-recorded", "bond-forfeited"]);
  assert.equal(entries.find(e => e.kind === "flake-recorded").reason, "judged_bad");
});

test("a note review leaves the bond locked", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed"),
    row(2, "c1", "reviewed", { verdict: "approved", summary: "looks good" }),
    row(3, "c1", "state_changed", { claimState: "done" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "bond-released"]);
});

test("renew keeps the bond locked; the later done still releases", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed"),
    row(2, "c1", "renewed"),
    row(3, "c1", "state_changed", { claimState: "done" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "bond-released"]);
});

test("reassign carries the bond; a later flake hits the new owner", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed", { ownerId: "lane-a" }),
    row(2, "c1", "reassigned", { ownerId: "lane-b", previousOwnerId: "lane-a" }),
    row(3, "c1", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-b" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "bond-carried", "flake-recorded", "bond-forfeited"]);
  assert.equal(entries[1].ownerId, "lane-b");
  assert.equal(entries.find(e => e.kind === "flake-recorded").ownerId, "lane-b");
});

test("done with no observed claim writes no phantom entries", () => {
  const entries = deriveShadowEntries([row(5, "c9", "state_changed", { claimState: "done" })]);
  assert.deepEqual(entries, []);
});

test("lease expiry with no open bond still records the flake, marked bond_posted=0", () => {
  const entries = deriveShadowEntries([
    row(5, "c9", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-z" })
  ]);
  assert.deepEqual(kinds(entries), ["flake-recorded"]);
  assert.equal(entries[0].bondPosted, 0);
  assert.equal(entries[0].ownerId, "lane-z");
});

test("unrelated actions write nothing", () => {
  const entries = deriveShadowEntries([
    row(1, "c1", "claimed"),
    row(2, "c1", "pr_merged"),
    row(3, "c1", "ci_changed"),
    row(4, "c1", "state_changed", { claimState: "blocked" }),
    row(5, "c1", "state_changed", { claimState: "done" })
  ]);
  assert.deepEqual(kinds(entries), ["bond-locked", "bond-released"]);
});

function seedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE events (room_id TEXT, sequence INT, id TEXT, body TEXT)`);
  return db;
}

function insertEvent(db, seq, claimId, action, data = {}) {
  const body = JSON.stringify({
    id: `e${seq}`,
    type: "work_claim.updated",
    actorId: "lane-a",
    at: new Date(T0 + seq * 60_000).toISOString(),
    roomId: "muse-room",
    data: { workClaim: claimId, action, claimState: "claimed", ownerId: "lane-a", ...data }
  });
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("muse-room", seq, `e${seq}`, body);
}

test("syncShadowJournal is idempotent across re-runs", () => {
  const db = seedDb();
  insertEvent(db, 1, "c1", "claimed");
  insertEvent(db, 2, "c1", "state_changed", { claimState: "done" });
  insertEvent(db, 3, "c2", "claimed", { ownerId: "lane-b" });
  insertEvent(db, 4, "c2", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-b" });
  const first = syncShadowJournal(db);
  assert.equal(first.eventsRead, 4);
  assert.equal(first.entriesWritten, 5);
  const second = syncShadowJournal(db);
  assert.equal(second.entriesWritten, 0);
  const total = db.prepare("SELECT COUNT(*) AS c FROM claim_bond_shadow").get().c;
  assert.equal(total, 5);
  db.close();
});

test("shadowReport computes flake rate and the concentration verdict", () => {
  const db = seedDb();
  // 12 locks; lane-flaky flakes 8 times, two others flake once each.
  let seq = 0;
  for (let i = 0; i < 12; i += 1) {
    const owner = i < 8 ? "lane-flaky" : i < 10 ? "lane-x" : "lane-y";
    insertEvent(db, ++seq, `c${i}`, "claimed", { ownerId: owner });
  }
  for (let i = 0; i < 8; i += 1) {
    insertEvent(db, ++seq, `c${i}`, "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-flaky" });
  }
  insertEvent(db, ++seq, "c8", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-x" });
  insertEvent(db, ++seq, "c9", "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: "lane-y" });
  insertEvent(db, ++seq, "c10", "state_changed", { claimState: "done" });
  insertEvent(db, ++seq, "c11", "state_changed", { claimState: "done" });
  syncShadowJournal(db);
  const report = shadowReport(db);
  assert.equal(report.locked, 12);
  assert.equal(report.released, 2);
  assert.equal(report.forfeited, 10);
  assert.equal(report.flakes, 10);
  assert.equal(report.flakeRate, 10 / 12);
  assert.equal(report.topFlakers[0].ownerId, "lane-flaky");
  assert.equal(report.topFlakers[0].flakes, 8);
  assert.ok(report.top3Share >= 0.5);
  assert.equal(report.verdict, "concentrated");
  db.close();
});

test("shadowReport says insufficient_data below the flake floor", () => {
  const db = seedDb();
  ensureShadowSchema(db);
  const report = shadowReport(db);
  assert.equal(report.verdict, "insufficient_data");
  assert.equal(report.flakeRate, null);
  db.close();
});

test("shadowReport says dispersed when flakes are ambient", () => {
  const db = seedDb();
  let seq = 0;
  for (let i = 0; i < 10; i += 1) {
    insertEvent(db, ++seq, `c${i}`, "claimed", { ownerId: `lane-${i}` });
    insertEvent(db, ++seq, `c${i}`, "lease_expired", { claimState: "unclaimed", ownerId: null, previousOwnerId: `lane-${i}` });
  }
  syncShadowJournal(db);
  const report = shadowReport(db);
  assert.equal(report.flakes, 10);
  assert.equal(report.verdict, "dispersed");
  db.close();
});

test("openBonds counts a claim that was released and re-claimed as open", () => {
  // Regression: the EXCEPT form compared whole claim_id sets, so a claim in
  // both the locked and the released sets (re-claimed after done) was dropped
  // entirely and openBonds reported 0 while the bond was actually open.
  const db = seedDb();
  let seq = 0;
  insertEvent(db, ++seq, "c1", "claimed", { ownerId: "lane-a" });
  insertEvent(db, ++seq, "c1", "state_changed", { claimState: "done" });
  insertEvent(db, ++seq, "c1", "claimed", { ownerId: "lane-b" });
  syncShadowJournal(db);
  const report = shadowReport(db);
  assert.equal(report.locked, 2);
  assert.equal(report.released, 1);
  assert.equal(report.openBonds, 1);
  db.close();
});

test("openBonds is 0 when every bond closed and counts a carried bond as open", () => {
  const db = seedDb();
  let seq = 0;
  insertEvent(db, ++seq, "c1", "claimed", { ownerId: "lane-a" });
  insertEvent(db, ++seq, "c1", "state_changed", { claimState: "done" });
  insertEvent(db, ++seq, "c2", "claimed", { ownerId: "lane-a" });
  insertEvent(db, ++seq, "c2", "reassigned", { ownerId: "lane-b", previousOwnerId: "lane-a" });
  syncShadowJournal(db);
  const report = shadowReport(db);
  assert.equal(report.openBonds, 1, "c1 closed, c2 carried and still open");
  db.close();
});
