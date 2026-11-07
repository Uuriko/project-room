// CURE-SMALL-SPECIMENS (money-core deep-dive charter 6, specimens S1/S6/S7).
//
// S1: acceptWork sampled nowMs() twice for one acceptance instant — the
// bounty.accepted event payload's challengeEnds and the stored
// challengeEndsMs diverged under a ticking clock. Fixed by sampling once.
// S7: the handleWorkClaims wrapper read wall-clock Date.now() for the
// deploy-status cache and the pull-budget gate, bypassing store.now().
// Fixed by routing both through store.now() (the narrowed C8 specimen:
// budget gate + deploy-status cache only — the lease/board leg was
// refuted, the core already recomputed from store.now()).
// S6: documentation-only — the dispute timeout's strict-> boundary is
// pinned here as intended behaviour so a future "alignment" is a visible
// behaviour change, not a silent one.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, DISPUTE_TIMEOUT_MS } from "../server/bounty-escrow.mjs";
import { escrowEpochNextDueAt } from "../server/bounty-epoch-keeper.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { writeClaimPullBudget } from "../server/claim-pr-sync.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const CODEX = "id:agent/codex";

// --- S1 -----------------------------------------------------------------

function tickingEscrow(stepMs = 3) {
  let t = 1_786_000_000_000;
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => { const v = t; t += stepMs; return v; }, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, now: () => t };
}

function runToAcceptedTicking(escrow, now, amount) {
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: new Date(now() + 3_600_000).toISOString() }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  return escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(now()).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
}

for (const amount of [10, 0.5]) {
  test(`S1: event-payload challengeEnds equals stored challengeEndsMs under a ticking clock (amount ${amount})`, () => {
    const { escrow, now } = tickingEscrow(3);
    const accepted = runToAcceptedTicking(escrow, now, amount);
    const stored = escrow.getBounty(ROOM, accepted.bounty.bountyId);
    const event = escrow.listEvents(ROOM).find(e => e.type === "bounty.accepted" && e.bountyId === stored.bountyId);
    assert.ok(event, "bounty.accepted event exists");
    assert.equal(Date.parse(event.data.challengeEnds), stored.challengeEndsMs,
      "announced challenge end must equal the enforced (stored) end exactly");
    assert.equal(Date.parse(accepted.receipt.event.data.challengeEnds), stored.challengeEndsMs);
    assert.equal(stored.challengeEnds, new Date(stored.challengeEndsMs).toISOString());
  });
}

// --- S6 (behaviour pinned as documented-intended) ------------------------

test("S6: dispute timeout does not fire at opened+14d exactly and fires at +1ms; nextDueAt reports +1", () => {
  let t = 1_786_000_000_000;
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction, now: () => t };
  const escrow = new BountyEscrow(store, { now: () => t, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: new Date(t + 3_600_000).toISOString(), verifierId: "id:agent/instinct" }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(t).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
  const opened = escrow.getBounty(ROOM, bounty.bountyId).disputeOpenedMs;
  assert.equal(escrowEpochNextDueAt(store, t), opened + DISPUTE_TIMEOUT_MS + 1);
  t = opened + DISPUTE_TIMEOUT_MS;
  assert.throws(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), /nothing to finalize/);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  t = opened + DISPUTE_TIMEOUT_MS + 1;
  const done = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(done.action, "released");
});

// --- S7 -----------------------------------------------------------------

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const SHA = "a".repeat(40);
const githubResponse = body => ({
  ok: true, status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function pinnedRoom(t, fixedMs) {
  const store = new RoomStore(":memory:", { now: () => fixedMs });
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
    ...extra,
  });
  return { store, call };
}

async function linkedClaim(f, id) {
  await f.call("create", null, { id, title: id, pullRequest: "https://github.com/example/repo/pull/7" });
  await f.call("claim", id, { leaseHours: 2 });
}

test("S7: pull-budget gate follows store.now() — budget held under the store clock blocks the sweep lookup even though the wall clock is past it", async t => {
  const FIXED = Date.UTC(2026, 9, 16, 2, 0, 0); // wall clock at grading was 2026-10-25, past FIXED+24h
  const f = pinnedRoom(t, FIXED);
  await linkedClaim(f, "gated");
  writeClaimPullBudget(f.store, FIXED + 24 * 3600 * 1000, FIXED);
  let fetches = 0;
  const fetchPullRequest = async () => { fetches += 1; return githubResponse({ state: "open", merged: false, head: { sha: SHA } }); };
  const out = await f.call("sweep", null, {}, { fetchPullRequest, githubToken: "test-token" });
  assert.equal(out.status, 200);
  assert.equal(fetches, 0, "store clock says the budget is still held: no GitHub lookup");
  const item = f.store.workClaims.get("commons", "gated");
  assert.equal(item.state, "claimed", "nothing else about the sweep changed");
});

test("S7: pull-budget gate follows store.now() — budget expired under a future store clock allows the sweep lookup even though the wall clock is still inside it", async t => {
  const FIXED = Date.UTC(2027, 0, 1, 0, 0, 0);
  const f = pinnedRoom(t, FIXED);
  await linkedClaim(f, "expired");
  writeClaimPullBudget(f.store, FIXED - 24 * 3600 * 1000, FIXED);
  let fetches = 0;
  const fetchPullRequest = async url => {
    fetches += 1;
    const target = String(url);
    if (target.endsWith("/status")) return githubResponse({ state: "pending", total_count: 1, statuses: [] });
    if (target.endsWith("/check-runs")) return githubResponse({ check_runs: [] });
    return githubResponse({ state: "open", merged: false, head: { sha: SHA } });
  };
  const out = await f.call("sweep", null, {}, { fetchPullRequest, githubToken: "test-token" });
  assert.equal(out.status, 200);
  assert.ok(fetches >= 1, "store clock says the budget expired: the sweep polls GitHub");
  const item = f.store.workClaims.get("commons", "expired");
  assert.equal(item.state, "claimed", "nothing else about the sweep changed");
});
