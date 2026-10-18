// REL-18: graceful degradation when GitHub is unconfigured.
// Sweep of every GitHub-backed path on main. With no token, a 401, or an
// unreachable GitHub, each path returns a named outcome and never throws
// a raw error that the route would turn into a 500.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { readRoomDeployStatus, refreshMainHeadCache, collectPullRequestLookups } from "../server/claim-pr-sync.mjs";
import { readBoardDeployStatus } from "../server/work-claim-integrity.mjs";
import { boardHtml } from "../src/board-ui.js";
import { discoverUnlinkedPulls } from "../server/claim-autolink.mjs";
import { installationToken, GitHubAppError } from "../server/github-app/auth.mjs";

const res = status => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => ({ message: "Bad credentials" }) });
const transports = {
  "no network": async () => { throw new TypeError("fetch failed"); },
  "401 bad credentials": async () => res(401),
  "500 from GitHub": async () => res(500)
};

test("deploy status (GET /work-claims/status) degrades to the cached value, never throws", async t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close?.());
  for (const [name, fetchImpl] of Object.entries(transports)) {
    const status = await readRoomDeployStatus(store, { fetchImpl, token: null, nowMs: 1_750_000_000_000 });
    assert.equal(typeof status, "object", name);
    assert.ok("live" in status && "main" in status, name);
  }
});

test("claim PR sweep reports unconfigured or error per item, never throws", async () => {
  // A due item must satisfy pullRequestDue: a live claim state and a
  // singular pullRequest carrying its url/repo/number (pullLinks shape).
  // The previous fixture ({repo, number, pullRequests:[{repo, number}]})
  // had neither, so it was filtered out as not due, fetch was never
  // invoked, and the assertions below could not fail.
  const pull = { url: "https://github.com/acme/private/pull/7", repo: "acme/private", number: 7 };
  const items = [{ roomId: "r1", id: "c1", state: "in_progress", pullRequest: pull, pullRequests: [pull] }];
  const expectedKind = {
    "no network": "error",
    "401 bad credentials": "unconfigured",
    "500 from GitHub": "error"
  };
  for (const [name, fetchImpl] of Object.entries(transports)) {
    const calls = [];
    const countingFetch = async (...args) => { calls.push(args); return fetchImpl(...args); };
    const batch = await collectPullRequestLookups(items, { fetchImpl: countingFetch, token: null, nowMs: 1_750_000_000_000 });
    assert.equal(calls.length, 1, `${name}: the lookup must actually reach fetch`);
    assert.equal(String(calls[0][0]), "https://api.github.com/repos/acme/private/pulls/7", name);
    assert.equal(batch.results.length, 1, name);
    assert.equal(batch.results[0].claimId, "c1", name);
    assert.equal(batch.results[0].roomId, "r1", name);
    assert.equal(batch.results[0].url, pull.url, name);
    assert.equal(batch.results[0].kind, expectedKind[name], name);
    assert.equal(batch.rateLimitedUntil, null, name);
    assert.equal(batch.budgetExceeded, false, name);
  }
  const unauth = await collectPullRequestLookups(items, { fetchImpl: transports["401 bad credentials"], token: null, nowMs: 1 });
  assert.equal(unauth.results.length, 1, "a 401 still produces a per-item result");
  assert.equal(unauth.results[0].kind, "unconfigured", "a 401 is reported as unconfigured");
  const kinds = JSON.stringify(unauth);
  assert.ok(!/"kind":"open"/.test(kinds), "a 401 is never read as an open PR");
});

test("PR autolink discovery with no token never throws", async t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close?.());
  for (const [name, fetchImpl] of Object.entries(transports)) {
    const out = await discoverUnlinkedPulls(store, { env: {}, fetchImpl, token: null, nowMs: 1_750_000_000_000 });
    assert.equal(typeof out, "object", name);
  }
});

test("GitHub App token without credentials is a named not_configured error, with no network call", async () => {
  let called = false;
  await assert.rejects(
    installationToken("123", { env: {}, fetchFn: async () => { called = true; return res(200); } }),
    error => error instanceof GitHubAppError && error.code === "not_configured");
  assert.equal(called, false);
});

// A failed GitHub read hands back the CACHED main. That value can predate a
// deploy, so it must be marked stale: the Board chip only says "Live differs
// from main" for a fresh read, and a rate-limited GitHub right after a deploy
// used to produce a false mismatch. STATUS-LEG (C-07): the GitHub read is
// the claim-prs job's (refreshMainHeadCache); the route's reader
// (readBoardDeployStatus) only ever serves the cache the job left behind.
const SHA_OLD = "a".repeat(40), SHA_LIVE = "b".repeat(40);
const failedReads = {
  "403": async () => res(403),
  "429": async () => res(429),
  "thrown fetch": async () => { throw new TypeError("fetch failed"); },
  "5xx": async () => res(503)
};
const chipFor = status => /<p class="live-chip">([^<]*)<\/p>/.exec(boardHtml([], status, { id: "u1", manage: false, owner: false, write: true }, {}, Date.now(), { canWrite: true }))?.[1];

for (const [name, fetchImpl] of Object.entries(failedReads)) {
  test(`deploy status after a failed GitHub read (${name}) is stale and the chip stays unknown`, async t => {
    const store = new RoomStore(":memory:");
    t.after(() => store.close?.());
    // A cached main from before the deploy; the live build is newer.
    store.db.prepare("INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)")
      .run("_claim-main-head", JSON.stringify({ sha: SHA_OLD, behind: null, checkedAt: "2026-10-11T00:00:00.000Z" }), 1);
    await refreshMainHeadCache(store, { fetchImpl, token: null, nowMs: 1_750_000_000_000, force: true });
    const status = readBoardDeployStatus(store, { nowMs: 1_750_000_000_000 });
    assert.equal(status.main, SHA_OLD, "the cached main is still reported");
    assert.equal(status.stale, true, "a fallback to the cache is stale");
    assert.equal(chipFor({ ...status, live: SHA_LIVE }), "Deploy status unknown", "no false mismatch from a stale cache");
  });
}

test("a successful GitHub read is fresh and a real mismatch shows", async t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close?.());
  const ok = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ sha: SHA_OLD }), text: async () => JSON.stringify({ sha: SHA_OLD }) });
  await refreshMainHeadCache(store, { fetchImpl: ok, token: null, nowMs: 1_750_000_000_000, force: true });
  const status = readBoardDeployStatus(store, { nowMs: 1_750_000_000_000 });
  assert.equal(status.stale, false);
  assert.equal(status.main, SHA_OLD);
  assert.equal(chipFor({ ...status, live: SHA_LIVE }), "Live differs from main");
});

// A failed job read never freshens the cache, so every reader after it —
// inside the 60 s window or not — keeps seeing the cached main as stale.
for (const name of ["403", "thrown fetch", "5xx"]) {
  test(`a second reader right after a failed GitHub read (${name}) still sees stale`, async t => {
    const store = new RoomStore(":memory:");
    t.after(() => store.close?.());
    store.db.prepare("INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)")
      .run("_claim-main-head", JSON.stringify({ sha: SHA_OLD, behind: null, checkedAt: "2026-10-11T00:00:00.000Z" }), 1);
    const nowMs = 1_750_000_000_000;
    await refreshMainHeadCache(store, { fetchImpl: failedReads[name], token: null, nowMs, force: true });
    const second = readBoardDeployStatus(store, { nowMs: nowMs + 5_000 });
    assert.equal(second.main, SHA_OLD);
    assert.equal(second.stale, true, "the failed job read left the cache stale");
    assert.equal(chipFor({ ...second, live: SHA_LIVE }), "Deploy status unknown");
  });
}
