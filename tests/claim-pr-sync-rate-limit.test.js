// bug-claim-pr-sync-rate-limited-no-settle-20261010. Prod has no GITHUB_TOKEN
// (wrangler secret list, names only), so the per-pull REST poll is anonymous:
// 60 core requests an hour per egress IP, shared on Cloudflare. Once that quota
// is spent, the shared budget row skipped every tick until the reset and merged
// pulls (#2479, #2492) never settled their held claims, while /api/health/jobs
// still said claim-prs "ok" with lastSummary.rateLimited true.
// 1. One search call per repo (separate search quota) settles recently merged or
//    closed pulls even while the core budget is spent.
// 2. A rate-limited claim-prs tick reads "degraded" in health, still HTTP 200.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests, writeClaimPullBudget } from "../server/claim-pr-sync.mjs";
import { applyOutcomes, jobHealthResponse, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

const NOW = Date.UTC(2026, 9, 10, 19, 0, 0);
const REPO = "https://github.com/Uuriko/project-room/pull/";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  const hold = (id, number, owner = "grok") => {
    let item = claimWork(createWork({ id }, { now: NOW - 3600000, agentId: owner }), owner, { now: NOW - 3600000, leaseHours: null });
    item = appendWorkPullRequest(item, owner, { pullRequest: REPO + number, expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: NOW - 3600000 });
    registry.set("muse-room", item);
  };
  return { store: { db, workClaims: registry }, registry, hold };
}

function searchOnly(items, calls) {
  return async url => {
    calls.push(url);
    if (!String(url).startsWith("https://api.github.com/search/issues?")) return { status: 403, ok: false, headers: { get: key => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3000) })[key.toLowerCase()] ?? null }, text: async () => "{}", json: async () => ({}) };
    const body = JSON.stringify({ total_count: items.length, items });
    return { status: 200, ok: true, headers: { get: key => key.toLowerCase() === "content-length" ? String(body.length) : null }, text: async () => body, json: async () => JSON.parse(body) };
  };
}

test("while the core budget is spent, one search per repo settles merged and closed pulls", async () => {
  const { store, registry, hold } = setup();
  hold("merged-one", 2479); hold("closed-one", 2480); hold("still-open", 2481);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const calls = [];
  const items = [
    { number: 2479, state: "closed", pull_request: { url: "x", merged_at: "2026-10-10T18:23:19Z" } },
    { number: 2480, state: "closed", pull_request: { url: "x", merged_at: null } },
    { number: 9999, state: "closed", pull_request: { url: "x", merged_at: "2026-10-10T18:00:00Z" } }
  ];
  const out = await syncClaimPullRequests(store, { fetchImpl: searchOnly(items, calls), nowMs: NOW, token: null });
  assert.equal(registry.get("muse-room", "merged-one").state, "done");
  assert.equal(registry.get("muse-room", "merged-one").deliveryMode, "merged");
  assert.notEqual(registry.get("muse-room", "closed-one").state, "claimed", "a closed pull releases its claim");
  assert.equal(registry.get("muse-room", "still-open").state, "claimed");
  assert.equal(calls.filter(url => url.includes("/search/issues")).length, 1, "one search call for the repo");
  assert.equal(calls.filter(url => !url.includes("/search/issues")).length, 0, "no core call while the budget is spent");
  assert.equal(out.rateLimited, true);
  assert.equal(out.searchSettled, 2);
});

test("search off switch: CLAIM_PR_SEARCH_BATCH=0 keeps the old skip", async () => {
  const { store, registry, hold } = setup();
  hold("merged-one", 2479);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const calls = [];
  await syncClaimPullRequests(store, { env: { CLAIM_PR_SEARCH_BATCH: "0" }, fetchImpl: searchOnly([{ number: 2479, state: "closed", pull_request: { merged_at: "2026-10-10T18:23:19Z" } }], calls), nowMs: NOW, token: null });
  assert.equal(calls.length, 0);
  assert.equal(registry.get("muse-room", "merged-one").state, "claimed");
});

test("a rate-limited claim-prs tick reads degraded, not ok, and stays HTTP 200", () => {
  const now = NOW;
  const stored = applyOutcomes({}, [{ job: "claim-prs", ok: true, at: now - 10_000, summary: { checked: 0, updated: 0, rateLimited: true } }]);
  const view = jobHealthView(stored, now);
  const job = view.jobs.find(entry => entry.name === "claim-prs");
  assert.equal(job.status, "degraded");
  assert.equal(job.degraded, "github_rate_limited");
  assert.notEqual(view.status, "ok");
  assert.equal(jobHealthResponse({ ...view, status: "degraded" }).status, 200, "degraded is visible, not an outage");
  const clean = applyOutcomes(stored, [{ job: "claim-prs", ok: true, at: now, summary: { checked: 1, updated: 0 } }]);
  assert.notEqual(jobHealthView(clean, now).jobs.find(entry => entry.name === "claim-prs").status, "degraded");
});
