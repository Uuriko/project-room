// FIX-14 (WAVE-300): expiry freezes the checkpoint as `last_progress`.
// The expiry sweep drops files, fileBlocks, attestations, and reviews from
// the live claim — but a successor re-claiming the work needs to see what
// the lapsed round had done. At expiry time the sweep freezes those four
// fields into `last_progress` BEFORE clearing them.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, attestWork, recordReview, releaseExpired }
  from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-09T20:00:00.000Z");
const H = 3600 * 1000;

const buildRound = () => {
  const created = createWork({ id: "w-checkpoint", title: "checkpoint me",
    files: ["server/work-claims.mjs"] }, { now: T0, agentId: "jill" });
  const claimed = claimWork(created, "quill", {
    leaseHours: 1, fileBlocks: { "server/work-claims.mjs": "fix-14" }, now: T0 });
  const attested = attestWork(claimed, "grok", { note: "looks right", now: T0 });
  return recordReview(attested, "fo", { verdict: "comment", summary: "one nit", now: T0 });
};

test("expiry freezes files/fileBlocks/attestations/reviews into last_progress", () => {
  const round = buildRound();
  const [expired] = releaseExpired([round], T0 + 2 * H);
  // Expiry semantics unchanged: back to unclaimed, owner and lease cleared.
  assert.equal(expired.state, "unclaimed");
  assert.equal(expired.owner, null);
  assert.equal(expired.leaseExpiresAt, null);
  // Live working fields are still cleared for the next round.
  assert.deepEqual(expired.files, []);
  assert.deepEqual(expired.fileBlocks, {});
  assert.deepEqual(expired.attestations, []);
  assert.deepEqual(expired.reviews, []);
  // But the checkpoint survives the sweep, frozen.
  const checkpoint = expired.last_progress;
  assert.ok(checkpoint, "last_progress must be set at expiry");
  assert.deepEqual(checkpoint.files, ["server/work-claims.mjs"]);
  assert.deepEqual(checkpoint.fileBlocks, { "server/work-claims.mjs": "fix-14" });
  assert.equal(checkpoint.attestations.length, 1);
  assert.equal(checkpoint.attestations[0].memberId, "grok");
  assert.equal(checkpoint.attestations[0].note, "looks right");
  assert.equal(checkpoint.reviews.length, 1);
  assert.equal(checkpoint.reviews[0].verdict, "comment");
  assert.equal(checkpoint.reviews[0].summary, "one nit");
  assert.equal(checkpoint.frozenAt, new Date(T0 + 2 * H).toISOString());
  assert.equal(checkpoint.frozenFrom, "quill");
  assert.ok(Object.isFrozen(checkpoint));
});

test("last_progress is null until the first expiry and survives normalization", () => {
  const round = buildRound();
  assert.equal(round.last_progress, null);
  const [expired] = releaseExpired([round], T0 + 2 * H);
  // The durable-registry read path re-validates every row through workOf —
  // simulate that shape (plain JSON) and sweep again: the checkpoint must
  // survive normalization even when the item does not expire a second time.
  const again = JSON.parse(JSON.stringify(expired));
  const [reswept] = releaseExpired([again], T0 + 2 * H);
  assert.equal(reswept.state, "unclaimed");
  assert.deepEqual(reswept.last_progress.files, ["server/work-claims.mjs"]);
  assert.equal(reswept.last_progress.frozenFrom, "quill");
  assert.ok(Object.isFrozen(reswept.last_progress));
});

test("a later expiry overwrites last_progress with the newer round", () => {
  const round = buildRound();
  const [expired] = releaseExpired([round], T0 + 2 * H);
  // Successor re-claims (the frozen checkpoint rides along for them to
  // read), does different work, then lapses again.
  const reclaimed = claimWork(expired, "instinct", { leaseHours: 1, now: T0 + 3 * H });
  assert.deepEqual(reclaimed.last_progress.files, ["server/work-claims.mjs"]);
  const [expired2] = releaseExpired([reclaimed], T0 + 5 * H);
  assert.equal(expired2.last_progress.frozenFrom, "instinct");
  assert.deepEqual(expired2.last_progress.files, []);
  assert.deepEqual(expired2.last_progress.attestations, []);
});
