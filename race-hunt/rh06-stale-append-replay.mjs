// RH-06: stale appendWorkPullRequest replay — the E5 compare-and-release guard.
// Round 1: owner links a PR with correct tokens. Round turns over (expiry).
// Round 2: a new owner replays round-1's (claimedAt, historyLength) tokens.
// Expectation: work_claim_conflict (409) every time — stale tokens never land.
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { createWork, claimWork, appendWorkPullRequest, releaseExpired, claimHistoryLength, ClaimError } =
  await import(REPO + "/server/work-claims.mjs");

const URL1 = "https://github.com/Uuriko/project-room/pull/1001";
const URL2 = "https://github.com/Uuriko/project-room/pull/1002";
const ITERS = Number(process.env.ITERS || 1000);
let bad = 0, staleOk = 0, freshOk = 0;
for (let i = 0; i < ITERS; i++) {
  const t = 1_700_000_000_000 + i * 10_000;
  let item = createWork({ id: `c${i}`, title: "t" }, { now: t, agentId: "system" });
  item = claimWork(item, "o1", { now: t, leaseHours: 1 });
  const r1At = item.claimedAt, r1Len = claimHistoryLength(item);
  item = appendWorkPullRequest(item, "o1", { pullRequest: URL1, expectedClaimedAt: r1At, expectedHistoryLength: r1Len, now: t });
  freshOk++;
  // round turns over: lease lapses
  item = releaseExpired([item], t + 2 * 3600 * 1000)[0];
  item = claimWork(item, "o2", { now: t + 2 * 3600 * 1000 + 1, leaseHours: 1 });
  // stale replay with round-1 tokens
  try {
    appendWorkPullRequest(item, "o2", { pullRequest: URL2, expectedClaimedAt: r1At, expectedHistoryLength: r1Len, now: t + 3 * 3600 * 1000 });
    bad++;
    if (bad <= 3) console.log(`round ${i}: STALE TOKENS ACCEPTED — guard failed`);
  } catch (e) {
    if (e instanceof ClaimError && e.code === "work_claim_conflict") staleOk++;
    else { bad++; console.log(`round ${i}: wrong error ${e.code ?? e.message}`); }
  }
  // fresh tokens for round 2 must succeed
  try {
    item = appendWorkPullRequest(item, "o2", { pullRequest: URL2, expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: t + 3 * 3600 * 1000 });
  } catch (e) { bad++; console.log(`round ${i}: FRESH TOKENS REJECTED ${e.code ?? e.message}`); }
}
console.log(`RH-06: ${ITERS} rounds, stale refused=${staleOk}, fresh accepted ok`);
console.log(bad === 0 ? "RH-06 RESULT: PASS — compare-and-release rejects every stale replay"
  : `RH-06 RESULT: FAIL — ${bad} guard violations`);
process.exit(bad === 0 ? 0 : 2);
