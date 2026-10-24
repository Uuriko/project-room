// HW-CAPTURE review-version archive (data preservation): the work-claim
// state machine keeps only the latest review record per member on the
// claim item — recordReview filters the member's prior record out, and
// attestWork supersedes a member's verdict the same way — so before this
// fix a re-review destroyed the earlier verdict record outright: its
// verdict, summary, url and basis survived nowhere (only a 512-char note
// on the "reviewed" history stamp remained). The durable registry now
// archives every displaced record in work_claim_review_history (keyed by
// lifetime seq) at set() time, so reviewHistory() returns every version
// ever recorded while the stored row — and every read model built on
// it — keeps the latest-per-member shape it has today.
//
// Invariants pinned here:
//  1. The live read model is unchanged: get() still shows only the
//     latest record per member in item.reviews.
//  2. reviewHistory() returns every version; per member the order is
//     the recording order, and the newest record per member equals the
//     live record.
//  3. A no-change set() (idempotent replay, get() round-trip) archives
//     nothing — only genuine displacement writes archive rows.
//  4. attestWork's supersede path archives the displaced verdict too.
//  5. Claim deletion removes the archive: a reused id starts clean.
//  6. A database without the sidecar (the pre-archive state) works
//     exactly as before: writes succeed, reviewHistory() returns the
//     live records, verifySchema tolerates the absence.
//  7. The archive survives closing and reopening the database file.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, claimWork, recordReview, attestWork } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";

const ROOM = "room-review-archive";
const BASE = Date.UTC(2026, 9, 19, 12, 0, 0);
const CREATOR = "agent-creator";
const OWNER = "agent-owner";
const REVIEWER = "agent-reviewer";
const SECOND = "agent-second";

function setup(db) {
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  assert.equal(registry.verifySchema(), true, "schema verifies with the review archive table");
  return registry;
}

function claimedClaim(registry, id) {
  let item = createWork({ id, title: `Claim ${id}` }, { now: BASE, agentId: CREATOR });
  registry.set(ROOM, item);
  item = claimWork(item, OWNER, { now: BASE + 1000 });
  registry.set(ROOM, item);
  return item;
}

function review(registry, item, member, verdict, summary, atMs) {
  const next = recordReview(item, member, { verdict, summary, now: atMs });
  registry.set(ROOM, next);
  return next;
}

const archiveRows = (db, id) =>
  db.prepare("SELECT seq, review_json FROM work_claim_review_history WHERE room_id=? AND claim_id=? ORDER BY seq ASC").all(ROOM, id);
const versionsFor = (registry, id, member) =>
  registry.reviewHistory(ROOM, id).filter(entry => entry.memberId === member);

test("a re-review archives the displaced verdict instead of destroying it", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  let item = claimedClaim(registry, "claim-rereview");
  item = review(registry, item, REVIEWER, "approve", "first pass: looks right", BASE + 2000);
  review(registry, item, REVIEWER, "changes_requested", "second look: found a gap", BASE + 3000);

  // Read model preserved: only the latest record per member is live.
  const live = registry.get(ROOM, "claim-rereview");
  assert.equal(live.reviews.length, 1);
  assert.equal(live.reviews[0].verdict, "changes_requested");
  assert.equal(live.reviews[0].summary, "second look: found a gap");

  // Every version is retrievable, oldest first, verbatim.
  const history = registry.reviewHistory(ROOM, "claim-rereview");
  assert.equal(history.length, 2);
  assert.equal(history[0].memberId, REVIEWER);
  assert.equal(history[0].verdict, "approve");
  assert.equal(history[0].summary, "first pass: looks right");
  assert.equal(history[1].verdict, "changes_requested");
  const rows = archiveRows(db, "claim-rereview");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].review_json).verdict, "approve");
  assert.equal(JSON.parse(rows[0].review_json).summary, "first pass: looks right");
});

test("re-saving an unchanged item archives nothing", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  let item = claimedClaim(registry, "claim-stable");
  item = review(registry, item, REVIEWER, "approve", "solid", BASE + 2000);
  registry.set(ROOM, item); // identical re-save (retry / replay)
  registry.set(ROOM, registry.get(ROOM, "claim-stable")); // get() round-trip
  assert.equal(archiveRows(db, "claim-stable").length, 0);
  assert.equal(registry.reviewHistory(ROOM, "claim-stable").length, 1);
});

test("versions accumulate across reviewers, each in recording order", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  let item = claimedClaim(registry, "claim-multi");
  item = review(registry, item, REVIEWER, "approve", "v1 approve", BASE + 2000);
  item = review(registry, item, SECOND, "comment", "v1 comment", BASE + 3000);
  item = review(registry, item, REVIEWER, "changes_requested", "v2 changes", BASE + 4000);
  review(registry, item, SECOND, "approve", "v2 approve", BASE + 5000);

  const live = registry.get(ROOM, "claim-multi");
  assert.equal(live.reviews.length, 2, "one live record per member");
  assert.deepEqual(versionsFor(registry, "claim-multi", REVIEWER).map(entry => entry.verdict),
    ["approve", "changes_requested"]);
  assert.deepEqual(versionsFor(registry, "claim-multi", SECOND).map(entry => entry.verdict),
    ["comment", "approve"]);
  assert.equal(registry.reviewHistory(ROOM, "claim-multi").length, 4);
  assert.equal(archiveRows(db, "claim-multi").length, 2, "exactly the two displaced records");
});

test("an attestation that supersedes a verdict archives the verdict", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  let item = claimedClaim(registry, "claim-attest");
  item = review(registry, item, REVIEWER, "approve", "approved before the note", BASE + 2000);
  const attested = attestWork(item, REVIEWER, { note: "withdrawing to a note", now: BASE + 3000 });
  registry.set(ROOM, attested);

  const live = registry.get(ROOM, "claim-attest");
  assert.equal(live.reviews.some(entry => entry.memberId === REVIEWER), false,
    "the attestation still supersedes the live verdict");
  const versions = versionsFor(registry, "claim-attest", REVIEWER);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].verdict, "approve");
  assert.equal(versions[0].summary, "approved before the note");
});

test("claim deletion removes the archive with the claim", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  let item = claimedClaim(registry, "claim-reused");
  item = review(registry, item, REVIEWER, "approve", "first life", BASE + 2000);
  review(registry, item, REVIEWER, "comment", "first life, revised", BASE + 3000);
  assert.equal(archiveRows(db, "claim-reused").length, 1);
  registry.delete(ROOM, "claim-reused");
  assert.equal(archiveRows(db, "claim-reused").length, 0);

  // A later claim reusing the id inherits none of the predecessor's verdicts.
  let fresh = claimedClaim(registry, "claim-reused");
  review(registry, fresh, REVIEWER, "approve", "second life", BASE + 4000);
  const history = registry.reviewHistory(ROOM, "claim-reused");
  assert.equal(history.length, 1);
  assert.equal(history[0].summary, "second life");
});

test("a database without the archive table behaves exactly as before", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  db.exec("DROP TABLE work_claim_review_history");
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  assert.equal(registry.verifySchema(), true, "absent sidecar is tolerated, not damage");

  let item = claimedClaim(registry, "claim-legacy");
  item = review(registry, item, REVIEWER, "approve", "first pass", BASE + 2000);
  review(registry, item, REVIEWER, "comment", "second pass", BASE + 3000);
  const live = registry.get(ROOM, "claim-legacy");
  assert.equal(live.reviews.length, 1);
  assert.equal(live.reviews[0].verdict, "comment");
  assert.deepEqual(registry.reviewHistory(ROOM, "claim-legacy").map(entry => entry.verdict), ["comment"]);
});

test("the archive survives closing and reopening the database file", () => {
  const directory = mkdtempSync(join(tmpdir(), "work-claim-review-history-"));
  const filename = join(directory, "claims.db");
  try {
    const db = new DatabaseSync(filename);
    const registry = setup(db);
    let item = claimedClaim(registry, "claim-durable");
    item = review(registry, item, REVIEWER, "approve", "before restart", BASE + 2000);
    review(registry, item, REVIEWER, "changes_requested", "after restart", BASE + 3000);
    db.close();

    const reopened = new DatabaseSync(filename);
    const registry2 = createDurableWorkClaimRegistry(reopened, { transaction: fn => fn() });
    assert.deepEqual(registry2.reviewHistory(ROOM, "claim-durable").map(entry => entry.summary),
      ["before restart", "after restart"]);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
