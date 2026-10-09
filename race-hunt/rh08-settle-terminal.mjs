// RH-08: settle a TERMINAL claim via a stale sweep observation.
// Round 1: o1 claims, links PR U. o1's claim reaches "done" (terminal) by a
// manual done transition WITHOUT the poller stamping an outcome on U.
// A racing sweep then commits a "merged" observation for U.
// Expectation: settlePullRequest refuses non-live claims → no double-settle,
// no second state:done stamp.
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { createWork, claimWork, appendWorkPullRequest, updateWork, claimHistoryLength } =
  await import(REPO + "/server/work-claims.mjs");
const { createWorkClaimRegistry } = await import(REPO + "/server/work-claim-routes.mjs");
const { commitPullRequestLookup } = await import(REPO + "/server/claim-pr-sync.mjs");

const URL = "https://github.com/Uuriko/project-room/pull/7777";
const room = "room1";
const reg = createWorkClaimRegistry();
const T0 = 1_700_000_000_000;

let item = createWork({ id: "c1", title: "t", reviewPolicy: "self_attested" }, { now: T0, agentId: "system" });
item = claimWork(item, "o1", { now: T0, leaseHours: 24 });
item = appendWorkPullRequest(item, "o1", { pullRequest: URL,
  expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: T0 });
// manual done transition (self_attested: owner may complete via in_progress)
item = updateWork(item, "o1", { state: "in_progress", now: T0 + 500 });
item = updateWork(item, "o1", { state: "done", deliveryMode: "result", now: T0 + 1000 });
reg.set(room, item);
const doneStampsBefore = item.history.filter(h => h.action === "state:done").length;
console.log(`terminal: state=${item.state} doneStamps=${doneStampsBefore}`);

// racing sweep commits a "merged" observation for the same URL
const settled = commitPullRequestLookup({}, reg, room, item,
  { claimId: "c1", roomId: room, url: URL, kind: "merged", mergedSha: "abc123" }, T0 + 2000);
const final = reg.get(room, "c1");
const doneStampsAfter = final.history.filter(h => h.action === "state:done").length;
console.log(`commit returned settled=${settled}; state=${final.state} doneStamps=${doneStampsAfter}`);

if (settled || doneStampsAfter !== doneStampsBefore || final.state !== "done") {
  console.log("RH-08 RESULT: RACE CONFIRMED — terminal claim double-settled");
  process.exit(2);
}
console.log("RH-08 RESULT: PASS — terminal claims are settle-proof");
