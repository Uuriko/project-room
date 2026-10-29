// UT2 L5 (release-history): a release binding derived ONLY from the
// documented board read must release a re-claimed (claimRound >= 2) claim.
//
// Executed defect (UT wave-2 lanes 03-10 F1 and 03-04 F1, same mechanism):
// the board list truncates each claim's history to the newest
// LIST_HISTORY_ENTRIES (3) entries, while releaseWork validates
// expectedHistoryLength against the FULL history (history.length +
// historyOmitted). The agent guide told holders to send "history length
// from the same read" — the truncated history.length — so a round-2
// holder's release 409'd "re-read the claim and retry" forever; only the
// full length, visible solely in the original claim response, worked.
//
// Cure pinned here: every board-page claim carries `historyLength`, the
// full history count the release validator checks (the same value as
// history.length + (historyOmitted ?? 0) on that record). The validator
// itself is unchanged: a truncated length alone, or a board binding taken
// before an intervening write, still conflicts.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, releaseWork, stampClaimHistory, claimHistoryLength } from "../server/work-claims.mjs";
import { buildWorkClaimPage } from "../server/work-claim-routes.mjs";

let clock = Date.parse("2026-10-27T16:50:00Z");
const now = () => (clock += 1000);

// One full claim round the way the claim route stamps it: claim plus the
// retention ack that follows it in the same commit.
function claimRound(item, agent) {
  const claimed = claimWork(item, agent, { now: now() });
  return stampClaimHistory(claimed, agent, { action: "retention_ack", note: "retention-ack", now: now() });
}

// Create -> claim (round 1) -> release -> re-claim (round 2), the UT repro:
// full history 6 = [created, claimed, retention_ack, state:unclaimed,
// claimed, retention_ack]; the board shows only the newest 3.
function roundTwoClaim(id) {
  let item = createWork({ id, title: "re-claimed work" }, { agentId: "poster", now: now() });
  item = claimRound(item, "worker-one");
  assert.equal(claimHistoryLength(item), 3);
  item = releaseWork(item, "worker-one", {
    expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: now() });
  assert.equal(item.state, "unclaimed");
  item = claimRound(item, "worker-two");
  assert.equal(item.claimRound, 2, "the re-claim opens round 2");
  assert.equal(claimHistoryLength(item), 6, "full history is 6, as in the UT repro");
  return item;
}

function boardClaim(item, viewer) {
  const page = buildWorkClaimPage([item], "room-l5", viewer, new URLSearchParams(), now());
  const claim = page.claims.find(entry => entry.id === item.id);
  assert.ok(claim, "the board lists the claim");
  return claim;
}

test("board read of a round-2 claim supplies the full history length the release validator checks", () => {
  const item = roundTwoClaim("l5-round-2");
  const board = boardClaim(item, "worker-two");
  assert.equal(board.history.length, 3, "the board history tail stays truncated to the newest 3 entries");
  assert.equal(board.claimedAt, item.claimedAt);
  assert.equal(board.historyLength, 6,
    "the board record names the full history length (history.length + (historyOmitted ?? 0))");
  assert.equal(board.historyLength, claimHistoryLength(item));
});

test("release with binding values derived only from the board read succeeds for a round-2 claim", () => {
  const item = roundTwoClaim("l5-release-round-2");
  const board = boardClaim(item, "worker-two");
  // Only board-supplied values: claimedAt + historyLength from the one read.
  const released = releaseWork(item, "worker-two", {
    expectedClaimedAt: board.claimedAt, expectedHistoryLength: board.historyLength, now: now() });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
});

test("release with binding values derived only from the board read succeeds for a round-1 claim", () => {
  let item = createWork({ id: "l5-round-1", title: "first-round work" }, { agentId: "poster", now: now() });
  item = claimRound(item, "worker-one");
  const board = boardClaim(item, "worker-one");
  assert.equal(board.historyLength, 3, "round 1: full history and the board tail agree");
  const released = releaseWork(item, "worker-one", {
    expectedClaimedAt: board.claimedAt, expectedHistoryLength: board.historyLength, now: now() });
  assert.equal(released.state, "unclaimed");
});

test("the validator's stale-binding protection is not weakened", () => {
  const item = roundTwoClaim("l5-stale");
  const board = boardClaim(item, "worker-two");
  // The truncated tail length alone was never the validator's value.
  assert.throws(() => releaseWork(item, "worker-two", {
    expectedClaimedAt: board.claimedAt, expectedHistoryLength: board.history.length, now: now() }),
  error => error.code === "work_claim_conflict",
  "history.length alone (3) still conflicts against the full history (6)");
  // A board binding taken before an intervening write is stale.
  const written = stampClaimHistory(item, "worker-two", { action: "noted", note: "progress", now: now() });
  assert.throws(() => releaseWork(written, "worker-two", {
    expectedClaimedAt: board.claimedAt, expectedHistoryLength: board.historyLength, now: now() }),
  error => error.code === "work_claim_conflict",
  "the pre-write board binding still conflicts after an intervening write");
  // The fresh board read of the written claim releases it.
  const fresh = boardClaim(written, "worker-two");
  assert.equal(fresh.historyLength, 7);
  const released = releaseWork(written, "worker-two", {
    expectedClaimedAt: fresh.claimedAt, expectedHistoryLength: fresh.historyLength, now: now() });
  assert.equal(released.state, "unclaimed");
});
