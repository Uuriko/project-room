// #1526: cron-vs-HTTP PR settlement race — the two settlement paths must
// agree on the settlement result for identical real-world events.
//
// B1: a stale prior-round CLOSED pull link must not veto the current round's
// MERGED pull request. batchPullOutcome/pullsReadyToSettle consider only the
// current round's links; a round-2 merge settles pr_merged (done), not
// pr_closed (released).
//
// B2: settle-after-expiry must not be path-dependent. The HTTP board path
// auto-releases lapsed leases before any settlement read; settlePullRequest
// refuses a lapsed lease outright, and the cron tick sweeps lapsed leases
// before polling, so a merged PR on a dead round is never credited as done.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims, createWorkClaimRegistry } from "../server/work-claim-routes.mjs";
import { commitPullRequestLookup, syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import {
  recordPullOutcome, pullsReadyToSettle, batchPullOutcome, settlePullRequest,
} from "../server/claim-coordination.mjs";
import {
  createWork, claimWork, appendWorkPullRequest, claimHistoryLength, isLeaseExpired,
} from "../server/work-claims.mjs";
import { flushClaimDigestWindow } from "../server/work-claim-events.mjs";

const PR1 = "https://github.com/Uuriko/project-room/pull/1500";
const PR2 = "https://github.com/Uuriko/project-room/pull/1501";
const PR3 = "https://github.com/Uuriko/project-room/pull/1502";
const ROOM = "qa-b-room";
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function linkPr(item, agent, url, nowMs) {
  return appendWorkPullRequest(item, agent, {
    pullRequest: url,
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: nowMs,
  });
}

test("B1 (#1526): round-2 merged PR settles pr_merged despite a stale round-1 closed link", () => {
  // Round 1: claim, link PR1, PR1 closes unmerged -> pr_closed settlement.
  let item = claimWork(createWork({ id: "b1-claim" }, { now: NOW, agentId: "alice" }), "alice", { now: NOW });
  item = linkPr(item, "alice", PR1, NOW);
  const r1 = recordPullOutcome(item, PR1, "closed", NOW);
  assert.equal(pullsReadyToSettle(r1), true);
  const settled1 = settlePullRequest(r1, batchPullOutcome(r1), NOW);
  assert.equal(settled1.action, "pr_closed");
  assert.equal(settled1.item.state, "unclaimed");

  // Round 2: re-claim (inherits the settled PR1 link), link PR2, PR2 merges.
  let round2 = claimWork(settled1.item, "alice", { now: NOW + 1000 });
  round2 = linkPr(round2, "alice", PR2, NOW + 1000);

  // Drive the real settlement path the cron and the sweep both call.
  const registry = createWorkClaimRegistry();
  registry.set(ROOM, round2);
  const current = registry.get(ROOM, "b1-claim");
  const settled = commitPullRequestLookup({}, registry, ROOM, current,
    { claimId: "b1-claim", url: PR2, kind: "merged" }, NOW + 2000);
  assert.equal(settled, true, "the lookup settled the claim");
  const final = registry.get(ROOM, "b1-claim");

  assert.equal(final.state, "done",
    `round-2's merged PR must settle as done, not as a release (state=${final.state})`);
  assert.equal(final.pullRequest.outcome, "merged",
    "settled record must not contradict itself (action pr_closed with pullRequest.outcome merged)");
});

test("B1 (#1526): stale settled links do not make a claim with only open current links ready", () => {
  let item = claimWork(createWork({ id: "b1-open" }, { now: NOW, agentId: "alice" }), "alice", { now: NOW });
  item = linkPr(item, "alice", PR1, NOW);
  const r1 = recordPullOutcome(item, PR1, "closed", NOW);
  const settled1 = settlePullRequest(r1, batchPullOutcome(r1), NOW);
  let round2 = claimWork(settled1.item, "alice", { now: NOW + 1000 });
  round2 = linkPr(round2, "alice", PR2, NOW + 1000);
  // PR2 has no outcome yet: not ready, even though the stale PR1 link is settled.
  assert.equal(pullsReadyToSettle(round2), false);
});

test("B2 (#1526): settlePullRequest refuses a claim whose lease has lapsed", () => {
  let item = claimWork(createWork({ id: "b2-claim" }, { now: NOW, agentId: "alice" }),
    "alice", { now: NOW, leaseHours: 1 });
  item = linkPr(item, "alice", PR3, NOW);
  const lapsedAt = NOW + 2 * 3600 * 1000;
  assert.equal(isLeaseExpired(item, lapsedAt), true, "precondition: the lease has lapsed");
  const recorded = recordPullOutcome(item, PR3, "merged", lapsedAt);
  assert.equal(settlePullRequest(recorded, "merged", lapsedAt), null,
    "a merged PR on a lapsed round must not settle as done");
});

test("B2 (#1526): a live lease still settles", () => {
  let item = claimWork(createWork({ id: "b2-live" }, { now: NOW, agentId: "alice" }),
    "alice", { now: NOW, leaseHours: 4 });
  item = linkPr(item, "alice", PR3, NOW);
  const at = NOW + 3600 * 1000;
  const recorded = recordPullOutcome(item, PR3, "merged", at);
  const settled = settlePullRequest(recorded, batchPullOutcome(recorded), at);
  assert.ok(settled, "a merged PR on a live lease settles");
  assert.equal(settled.action, "pr_merged");
});

async function roomStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: extra.auth ?? { member: { id: "owner", kind: "human", permissions: ["manage_claims"] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
  });
  return { store, call };
}

const claimEvents = store => {
  // FIX-69: routine transitions batch into work_claim.digest; flush and
  // flatten to the action list the assertions below read.
  flushClaimDigestWindow(store, "commons", {});
  const rows = store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence")
    .all("commons").map(row => JSON.parse(row.body));
  const out = [];
  for (const event of rows) {
    if (event.type === "work_claim.updated") out.push(event);
    else if (event.type === "work_claim.digest") {
      for (const entry of event.data.digestClaims) out.push({ data: entry });
    }
  }
  return out;
};

test("B2 (#1526): the cron tick sweeps lapsed leases before polling, matching the HTTP path", async t => {
  const { store, call } = await roomStore(t);
  await call("create", null, { id: "sweep-me", files: ["src/x.js"] });
  const claimed = (await call("claim", "sweep-me", { leaseHours: 1 })).value;
  await call("update", "sweep-me", {
    appendPullRequest: PR3,
    expectedClaimedAt: claimed.claimedAt,
    expectedHistoryLength: claimed.history.length,
  });
  // Push the lease into the past at the storage layer (the route layer
  // validates leaseHours > 0, so backdate the row directly).
  const row = store.workClaims.get("commons", "sweep-me");
  const lapsedAt = Date.parse(row.leaseExpiresAt) + 2 * 3600 * 1000;
  store.workClaims.set("commons", { ...row, leaseExpiresAt: new Date(Date.parse(row.leaseExpiresAt) - 3 * 3600 * 1000).toISOString() });

  const calls = [];
  const fetchImpl = async endpoint => {
    calls.push(endpoint);
    return { ok: true, status: 200, json: async () => ({ merged: true, state: "closed" }) };
  };
  const out = await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs: lapsedAt });
  assert.equal(calls.length, 0, "no poll for a lapsed claim: it was swept first");
  const after = store.workClaims.get("commons", "sweep-me");
  assert.equal(after.state, "unclaimed", "the lapsed claim was auto-released");
  assert.equal(after.owner, null);
  const actions = claimEvents(store).map(event => event.data.action);
  assert.ok(actions.includes("lease_expired"), `expected a lease_expired event, got ${actions.join(",")}`);
  assert.ok(!actions.includes("pr_merged"), "no settlement for the dead round");
  assert.equal(out.checked, 0);
});
