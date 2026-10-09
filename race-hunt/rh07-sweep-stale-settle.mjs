// RH-07: sweep settle applies a STALE pre-transaction GitHub observation to a
// NEW claim round. The sweep fetches PR state BEFORE opening its write
// transaction (deliberately, to not hold the lock over network I/O), then
// commitPullRequestLookup matches the result to the current row BY URL ONLY —
// no round token (expectedClaimedAt) check like appendWorkPullRequest has.
//
// Interleaving under test:
//   T0 sweep pre-reads claim C (round 1, owner o1, PR U linked, no outcome)
//   T1 sweep's GitHub fetch observes PR U = "closed"   (stale result captured)
//   T2 round 1 lapses (lease expiry); o2 claims C (round 2), re-links U
//      (o2 reopened the PR on GitHub after T1 — the supported re-link flow)
//   T4 sweep commits the T1 "closed" observation against round 2's row
// Expectation: the stale observation must NOT settle round 2.
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { createWork, claimWork, appendWorkPullRequest, releaseExpired, claimHistoryLength } =
  await import(REPO + "/server/work-claims.mjs");
const { createWorkClaimRegistry } = await import(REPO + "/server/work-claim-routes.mjs");
const { commitPullRequestLookup } = await import(REPO + "/server/claim-pr-sync.mjs");

const URL = "https://github.com/Uuriko/project-room/pull/4242";
const room = "room1";
const reg = createWorkClaimRegistry();
const T0 = 1_700_000_000_000;

// T0: round 1 — o1 claims, links PR U
let item = createWork({ id: "c1", title: "t" }, { now: T0, agentId: "system" });
item = claimWork(item, "o1", { now: T0, leaseHours: 1 });
item = appendWorkPullRequest(item, "o1", { pullRequest: URL,
  expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: T0 });
reg.set(room, item);

// T1: sweep fetch observes U="closed" (BEFORE the round turns over)
const staleResult = { claimId: "c1", roomId: room, url: URL, kind: "closed" };

// T2: round 1 lapses; o2 claims (round 2) and re-links U (reopened on GitHub)
item = releaseExpired([item], T0 + 2 * 3600 * 1000)[0];
item = claimWork(item, "o2", { now: T0 + 2 * 3600 * 1000 + 1, leaseHours: 24 });
item = appendWorkPullRequest(item, "o2", { pullRequest: URL,
  expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item),
  now: T0 + 2 * 3600 * 1000 + 2 });
reg.set(room, item);
console.log(`round 2 live: state=${item.state} owner=${item.owner} claimedAt=${item.claimedAt}`);

// T4: sweep commits the stale T1 observation inside its transaction
const settled = commitPullRequestLookup({}, reg, room, item, staleResult, T0 + 3 * 3600 * 1000);
const final = reg.get(room, "c1");
console.log(`commit returned settled=${settled}; final state=${final.state} owner=${final.owner}`);
console.log(`final link outcome=${final.pullRequest?.outcome ?? final.pullRequests?.[0]?.outcome} syncedAt=${final.pullRequest?.syncedAt ?? final.pullRequests?.[0]?.syncedAt}`);

if (settled || final.state !== "claimed" || final.owner !== "o2") {
  console.log("RH-07 RESULT: RACE CONFIRMED — stale pre-txn GitHub observation settled a live new round (cross-slice: claim logic, guild 01)");
  process.exit(2);
}
console.log("RH-07 RESULT: PASS — stale observation not applied to the new round");
