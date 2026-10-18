// STATUS-LEG (AUDIT-50X C-07): the Board deploy-status leg is materialized
// by the claim-prs job and served from cache only. Before this change the
// status route awaited a live GitHub commits/main fetch inside the room
// request (measured 1,470 ms leg gating board paint). These tests pin:
// (a) the route answers from cache with GitHub unreachable — it performs
//     no fetch at all, for any member, with or without ?refresh=1;
// (b) cache freshness/TTL behaviour: fresh inside 60 s, stale at/after it,
//     stale + heldUntil while the GitHub budget is held, and the job-side
//     refresh cadence (one read per TTL, ETag/304 revalidation, no read
//     while held);
// (c) the job wiring: syncClaimPullRequests materializes the cache even
//     with no pulls due, and the claim-prs job's due probe wakes for the
//     refresh on an otherwise idle board.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { readBoardDeployStatus, DEPLOY_STATUS_MAX_AGE_MS } from "../server/work-claim-integrity.mjs";
import {
  MAIN_HEAD_TTL_MS, deployStatusDueAt, readCachedDeployStatus, refreshMainHeadCache,
  syncClaimPullRequests, writeClaimPullBudget
} from "../server/claim-pr-sync.mjs";
import { jobByName, jobEnabled, jobIsDue, jobNextDue } from "../server/jobs.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T0 = Date.parse("2026-10-18T00:00:00.000Z");

const gh = (body, { status = 200, etag = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => (String(name).toLowerCase() === "etag" ? etag : null) },
  text: async () => JSON.stringify(body),
  json: async () => body
});

function storeFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}

function seedCache(store, { sha = SHA_A, checkedAtMs = T0, etag = null } = {}) {
  store.db.prepare("INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)")
    .run("_claim-main-head", JSON.stringify({ sha, behind: null, checkedAt: new Date(checkedAtMs).toISOString(), ...(etag ? { etag } : {}) }), checkedAtMs);
}

// --- (a) the route serves cache only -------------------------------------

test("status route answers from cache with GitHub unreachable, and ?refresh=1 fetches nothing", async t => {
  const store = storeFixture(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-reader", type: "member.added", data: { memberId: "reader", displayName: "Reader", kind: "agent", permissions: [] } });
  seedCache(store, { sha: SHA_B, checkedAtMs: Date.now() });
  let fetches = 0;
  const unreachable = async () => { fetches += 1; throw new TypeError("fetch failed"); };
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body
  };
  const call = async query => handleWorkClaims({
    req: { method: "GET" }, res: {},
    url: new URL(`https://room.example/api/rooms/commons/work-claims/status${query}`),
    store, roomId: "commons",
    auth: { member: { id: "reader", kind: "agent", permissions: [] } },
    workClaimRoute: "status", workClaimId: null, helpers, registry: store.workClaims,
    fetchPullRequest: unreachable, githubToken: "test-token"
  });
  for (const query of ["", "?refresh=1"]) {
    const out = await call(query);
    assert.equal(out.status, 200, query);
    assert.equal(out.value.main, SHA_B, query);
    assert.equal(out.value.stale, false, query);
    assert.equal(typeof out.value.eventsRemaining, "number", query);
  }
  assert.equal(fetches, 0, "the status route never fetches GitHub");
});

test("status route with an empty cache reports main:null stale, still without fetching", async t => {
  const store = storeFixture(t);
  const status = readBoardDeployStatus(store, { nowMs: T0 });
  assert.equal(status.main, null);
  assert.equal(status.checkedAt, null);
  assert.equal(status.stale, true, "nothing materialized yet is honestly stale, not a fetch trigger");
});

// --- (b) freshness / TTL ---------------------------------------------------

test("cache freshness: fresh inside the TTL, stale at and after it", async t => {
  const store = storeFixture(t);
  seedCache(store, { checkedAtMs: T0 });
  assert.equal(DEPLOY_STATUS_MAX_AGE_MS, MAIN_HEAD_TTL_MS, "route TTL and job TTL are the same 60 s floor");
  assert.equal(readBoardDeployStatus(store, { nowMs: T0 }).stale, false);
  assert.equal(readBoardDeployStatus(store, { nowMs: T0 + 59_999 }).stale, false);
  assert.equal(readBoardDeployStatus(store, { nowMs: T0 + 60_000 }).stale, true);
  assert.equal(readBoardDeployStatus(store, { nowMs: T0 + 3_600_000 }).stale, true);
  assert.equal(readBoardDeployStatus(store, { nowMs: T0 + 60_000 }).main, SHA_A, "stale still serves the cached value");
});

test("while the GitHub budget is held the cached value is stale with heldUntil", async t => {
  const store = storeFixture(t);
  seedCache(store, { checkedAtMs: T0 });
  writeClaimPullBudget(store, T0 + 600_000, T0);
  const status = readBoardDeployStatus(store, { nowMs: T0 + 1_000 });
  assert.equal(status.stale, true);
  assert.equal(status.heldUntil, new Date(T0 + 600_000).toISOString());
  assert.equal(status.main, SHA_A);
});

test("job refresh: one GitHub read per TTL, then ETag revalidation bumps only the check time", async t => {
  const store = storeFixture(t);
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), etag: options.headers?.["If-None-Match"] ?? null });
    if (seen.length === 1) return gh({ sha: SHA_B }, { etag: '"main-v1"' });
    return { ok: false, status: 304, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
  };
  const first = await refreshMainHeadCache(store, { fetchImpl, token: null, nowMs: T0 });
  assert.equal(first.refreshed, true);
  assert.equal(first.main, SHA_B);
  assert.equal(first.stale, false);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/commits\/main$/);
  assert.equal(readCachedDeployStatus(store).checkedAt, new Date(T0).toISOString());

  const early = await refreshMainHeadCache(store, { fetchImpl, token: null, nowMs: T0 + 30_000 });
  assert.equal(early.refreshed, false, "inside the TTL the job does not re-read");
  assert.equal(early.stale, false);
  assert.equal(seen.length, 1);

  const revalidated = await refreshMainHeadCache(store, { fetchImpl, token: null, nowMs: T0 + 60_000 });
  assert.equal(revalidated.refreshed, true, "at the TTL the job re-reads");
  assert.equal(seen.length, 2);
  assert.equal(seen[1].etag, '"main-v1"', "the revalidation sends the stored ETag");
  assert.equal(revalidated.main, SHA_B, "a 304 keeps the cached head");
  assert.equal(revalidated.stale, false, "a 304 is a fresh confirmation");
  assert.equal(readCachedDeployStatus(store).checkedAt, new Date(T0 + 60_000).toISOString());
  assert.equal(deployStatusDueAt(store, T0 + 60_000), T0 + 120_000, "the next refresh is a full TTL after the 304");
});

test("job refresh makes no GitHub read while the budget is held", async t => {
  const store = storeFixture(t);
  seedCache(store, { checkedAtMs: T0 });
  writeClaimPullBudget(store, T0 + 600_000, T0);
  let fetches = 0;
  const out = await refreshMainHeadCache(store, { fetchImpl: async () => { fetches += 1; return gh({ sha: SHA_B }); }, token: null, nowMs: T0 + 120_000, force: true });
  assert.equal(out.refreshed, false);
  assert.equal(fetches, 0);
  assert.equal(deployStatusDueAt(store, T0 + 120_000), T0 + 600_000, "the next due time is the hold's end");
});

// --- (c) job wiring ---------------------------------------------------------

test("deployStatusDueAt: no cache is due now; a fresh cache is due one TTL after its check", async t => {
  const store = storeFixture(t);
  assert.equal(deployStatusDueAt(store, T0), T0);
  seedCache(store, { checkedAtMs: T0 });
  assert.equal(deployStatusDueAt(store, T0), T0 + MAIN_HEAD_TTL_MS);
  assert.equal(deployStatusDueAt(store, T0 + MAIN_HEAD_TTL_MS), T0 + MAIN_HEAD_TTL_MS);
});

test("syncClaimPullRequests materializes the cache even with no pulls due", async t => {
  const store = storeFixture(t);
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return gh({ sha: SHA_B }); };
  const first = await syncClaimPullRequests(store, { env: {}, fetchImpl, token: null, nowMs: T0 });
  assert.equal(first.checked, 0, "no pulls were due");
  assert.equal(first.deployStatusRefreshed, 1, "the tick still materialized the main-HEAD cache");
  assert.equal(fetches, 1);
  assert.equal(readCachedDeployStatus(store).main, SHA_B);
  const second = await syncClaimPullRequests(store, { env: {}, fetchImpl, token: null, nowMs: T0 + 30_000 });
  assert.equal(second.deployStatusRefreshed, undefined, "inside the TTL the next tick does not re-read");
  assert.equal(fetches, 1);
});

test("claim-prs job wakes for the deploy-status refresh on an otherwise idle board", async t => {
  const store = storeFixture(t);
  const job = jobByName("claim-prs");
  assert.equal(jobEnabled(job, {}, store), true, "the standing deploy-status due time enables the job");
  assert.equal(jobNextDue(job, store, T0), T0, "with no cache the refresh is due now");
  assert.equal(jobIsDue(job, store, T0), true);
  seedCache(store, { checkedAtMs: T0 });
  assert.equal(jobNextDue(job, store, T0), T0 + MAIN_HEAD_TTL_MS, "the next wake is the refresh TTL");
  assert.equal(jobIsDue(job, store, T0 + MAIN_HEAD_TTL_MS - 1), false);
  assert.equal(jobIsDue(job, store, T0 + MAIN_HEAD_TTL_MS), true);
});
