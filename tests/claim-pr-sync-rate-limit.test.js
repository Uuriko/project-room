// bug-claim-pr-sync-rate-limited-no-settle-20261010. Prod has no GITHUB_TOKEN
// (wrangler secret list, names only), so the per-pull REST poll is anonymous:
// 60 core requests an hour per egress IP, shared on Cloudflare. Once that quota
// is spent, the shared budget row skipped every tick until the reset and merged
// pulls (#2479, #2492) never settled their held claims, while /api/health/jobs
// still said claim-prs "ok" with lastSummary.rateLimited true.
// 1. While the core budget is spent, one search per tick (separate quota) walks
//    the repo's merged pulls from a cursor and settles merged pulls only.
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

const API = "https://api.github.com/repos/Uuriko/project-room";
const hit = (number, merged = true, extra = {}) => ({
  number, state: "closed", created_at: new Date(NOW - 86400000 + number * 1000).toISOString().replace(".000", ""),
  repository_url: API, pull_request: { html_url: `https://github.com/Uuriko/project-room/pull/${number}`, merged_at: merged ? "2026-10-10T18:23:19Z" : null }, ...extra
});

function searchOnly(pages, calls, { searchStatus = 200, headers = {} } = {}) {
  return async url => {
    calls.push(String(url));
    if (!String(url).startsWith("https://api.github.com/search/issues?")) return { status: 403, ok: false, headers: { get: key => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3000) })[key.toLowerCase()] ?? null }, text: async () => "{}" };
    if (searchStatus !== 200) return { status: searchStatus, ok: false, headers: { get: key => headers[key.toLowerCase()] ?? null }, text: async () => "{}" };
    const items = typeof pages === "function" ? pages(decodeURIComponent(String(url))) : pages;
    const body = JSON.stringify({ total_count: items.length, items });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
  };
}

test("while the core budget is spent, one search settles merged pulls only, never on an unmerged close", async () => {
  const { store, registry, hold } = setup();
  hold("merged-one", 2479); hold("closed-one", 2480); hold("still-open", 2481);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const calls = [];
  const items = [hit(2479), hit(2480, false), hit(9999)];
  const out = await syncClaimPullRequests(store, { fetchImpl: searchOnly(items, calls), nowMs: NOW, token: null });
  assert.equal(registry.get("muse-room", "merged-one").state, "done");
  assert.equal(registry.get("muse-room", "merged-one").deliveryMode, "merged");
  assert.equal(registry.get("muse-room", "closed-one").state, "claimed", "an unmerged close can be reopened; REST decides it");
  assert.equal(registry.get("muse-room", "still-open").state, "claimed");
  assert.equal(calls.length, 1, "one search call, no core call while the budget is spent");
  assert.match(decodeURIComponent(calls[0]), /repo:Uuriko\/project-room is:pr is:merged merged:>=2026-09-26(&|$)/, "merge-time window, no created bound on the first page");
  assert.equal(out.rateLimited, true);
  assert.equal(out.searchSettled, 1);
});

test("a hit for another repo or a mismatched pull url settles nothing", async () => {
  const { store, registry, hold } = setup();
  hold("merged-one", 2479);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const items = [
    hit(2479, true, { repository_url: "https://api.github.com/repos/someone/else" }),
    hit(2479, true, { repository_url: "https://evil.example/repos/Uuriko/project-room" }),
    { ...hit(2479), pull_request: { html_url: "https://github.com/someone/else/pull/2479", merged_at: "2026-10-10T18:23:19Z" } },
    { ...hit(2479), pull_request: { html_url: "https://evil.example/someone/Uuriko/project-room/pull/2479", merged_at: "2026-10-10T18:23:19Z" } }
  ];
  await syncClaimPullRequests(store, { fetchImpl: searchOnly(items, []), nowMs: NOW, token: null });
  assert.equal(registry.get("muse-room", "merged-one").state, "claimed");
});

test("a full page continues from its cursor on the next tick, so older merges are not starved", async () => {
  const { store, registry, hold } = setup();
  hold("late", 2600);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const first = Array.from({ length: 50 }, (_, i) => hit(2000 + i));
  const calls = [];
  const pages = query => query.includes(`created:>=${first.at(-1).created_at}`) ? [hit(2600)] : first;
  await syncClaimPullRequests(store, { fetchImpl: searchOnly(pages, calls), nowMs: NOW, token: null });
  assert.equal(registry.get("muse-room", "late").state, "claimed", "page one does not have it");
  await syncClaimPullRequests(store, { fetchImpl: searchOnly(pages, calls), nowMs: NOW + 60_000, token: null });
  assert.equal(registry.get("muse-room", "late").state, "done", "page two, reached by the cursor, settles it");
  assert.equal(calls.length, 2);
});

test("a search 429 backs the search off by Retry-After on its own row", async () => {
  const { store, hold } = setup();
  hold("merged-one", 2479);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const calls = [];
  await syncClaimPullRequests(store, { fetchImpl: searchOnly([], calls, { searchStatus: 429, headers: { "retry-after": "120" } }), nowMs: NOW, token: null });
  await syncClaimPullRequests(store, { fetchImpl: searchOnly([hit(2479)], calls), nowMs: NOW + 90_000, token: null });
  assert.equal(calls.length, 1, "no search inside Retry-After");
  await syncClaimPullRequests(store, { fetchImpl: searchOnly([hit(2479)], calls), nowMs: NOW + 121_000, token: null });
  assert.equal(calls.length, 2);
});

test("search off switch: CLAIM_PR_SEARCH_BATCH=0 keeps the old skip", async () => {
  const { store, registry, hold } = setup();
  hold("merged-one", 2479);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const calls = [];
  await syncClaimPullRequests(store, { env: { CLAIM_PR_SEARCH_BATCH: "0" }, fetchImpl: searchOnly([hit(2479)], calls), nowMs: NOW, token: null });
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

test("a failing repo still passes the turn, so a healthy repo is searched next tick", async () => {
  const { store, registry, hold } = setup();
  hold("broken-repo", 1, "grok");
  const other = "https://github.com/aaa-broken/repo/pull/1";
  let item = registry.get("muse-room", "broken-repo");
  item = { ...item, pullRequest: { ...item.pullRequest, url: other, repo: "aaa-broken/repo", number: 1 }, pullRequests: [{ ...item.pullRequest, url: other, repo: "aaa-broken/repo", number: 1 }] };
  registry.set("muse-room", item);
  hold("healthy", 2479);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(decodeURIComponent(String(url)));
    if (calls.at(-1).includes("aaa-broken/repo")) return { status: 422, ok: false, headers: { get: () => null }, text: async () => "{}" };
    return searchOnly([hit(2479)], [])(url);
  };
  await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW, token: null });
  await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW + 60_000, token: null });
  assert.ok(calls[0].includes("aaa-broken/repo") && calls[1].includes("Uuriko/project-room"), calls.join("\n"));
  assert.equal(registry.get("muse-room", "healthy").state, "done");
});

test("51 merged pulls sharing one created second: the 51st is reached by paging within that second", async () => {
  const { store, registry, hold } = setup();
  hold("tie-51", 3050);
  writeClaimPullBudget(store, NOW + 3000_000, NOW);
  const same = "2026-10-09T10:00:00Z";
  const all = Array.from({ length: 51 }, (_, i) => hit(3000 + i, true, { created_at: same }));
  const calls = [];
  const pages = query => {
    const page = Number((query.match(/&page=(\d+)/) ?? [])[1] ?? 1);
    return all.slice((page - 1) * 50, page * 50);
  };
  for (let tick = 0; tick < 3 && registry.get("muse-room", "tie-51").state !== "done"; tick++) {
    await syncClaimPullRequests(store, { fetchImpl: searchOnly(pages, calls), nowMs: NOW + tick * 60_000, token: null });
  }
  assert.equal(registry.get("muse-room", "tie-51").state, "done", calls.map(decodeURIComponent).join("\n"));
  const shape = calls.map(url => decodeURIComponent(url)).map(q => [(q.match(/created:>=(\S+?)(&|$)/) ?? [])[1] ?? null, (q.match(/&page=(\d+)/) ?? [])[1] ?? "1"]);
  assert.deepEqual(shape, [[null, "1"], [same, "1"], [same, "2"]]);
});
