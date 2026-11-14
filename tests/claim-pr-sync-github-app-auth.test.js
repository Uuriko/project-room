// Claim-pr-sync GitHub credential resolution (Pack 23 wiring).
//
// The production claim-prs job ran unauthenticated because the sync
// resolved only GITHUB_TOKEN/GH_TOKEN and neither is set in the Worker,
// while the GitHub App credentials sit in the inventory under
// ROOM_GITHUB_APP_* names no code read. These tests pin the resolution:
// the App installation-token path first (through the shared
// server/github-app/auth.mjs machinery, never hand-rolled), the static
// token as fallback, and an unauthenticated tick — reported honestly in
// the summary — when no credential exists. All key material below is a
// throwaway fixture key generated in-process for this test run only.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { githubAppCredentials, githubAppInstallationId, installationToken } from "../server/github-app/auth.mjs";
import { resolveGithubAccess, syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FIXTURE_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const INSTALLATION_ID = "4242";

function roomAppEnv(extra = {}) {
  return {
    ROOM_GITHUB_APP_ID: "123456",
    ROOM_GITHUB_APP_PRIVATE_KEY: FIXTURE_PEM,
    ROOM_GITHUB_APP_WEBHOOK_SECRET: "fixture-webhook-secret",
    ROOM_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    ...extra
  };
}

function jsonResponse({ status = 200, body = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

// A GitHub stub that only mints installation tokens. Records every call
// (url + Authorization) and hands out a fresh token per mint, expiring
// one hour after the pinned tick clock it is given.
function mintOnlyFetch(calls, { failStatus = 0 } = {}) {
  let mints = 0;
  return async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.Authorization ?? null, body: init.body ?? null });
    if (!String(url).startsWith("https://api.github.com/app/installations/")) {
      throw new Error(`unexpected fetch in mint stub: ${url}`);
    }
    if (failStatus) return jsonResponse({ status: failStatus, body: { message: "refused" } });
    mints += 1;
    return jsonResponse({
      status: 201,
      body: { token: `fixture-inst-${mints}`, expires_at: new Date(NOW + 3_600_000).toISOString() }
    });
  };
}

test("the credential reader accepts the ROOM_ inventory names and the canonical names win", () => {
  const roomOnly = githubAppCredentials(roomAppEnv());
  assert.equal(roomOnly.appId, "123456");
  assert.equal(roomOnly.webhookSecret, "fixture-webhook-secret");
  const both = githubAppCredentials(roomAppEnv({ GITHUB_APP_ID: "777", GITHUB_APP_WEBHOOK_SECRET: "canonical-secret" }));
  assert.equal(both.appId, "777", "canonical GITHUB_APP_ID wins over ROOM_GITHUB_APP_ID");
  assert.equal(both.webhookSecret, "canonical-secret");
  assert.equal(githubAppCredentials({ ROOM_GITHUB_APP_ID: "1", ROOM_GITHUB_APP_PRIVATE_KEY: "x" }), null,
    "a missing webhook secret still leaves the App unconfigured");
});

test("the installation id reader takes either spelling and refuses non-numeric values", () => {
  assert.equal(githubAppInstallationId(roomAppEnv()), INSTALLATION_ID);
  assert.equal(githubAppInstallationId({ GITHUB_APP_INSTALLATION_ID: "9" }), "9");
  assert.equal(githubAppInstallationId({ ROOM_GITHUB_APP_INSTALLATION_ID: "9", GITHUB_APP_INSTALLATION_ID: "10" }), "10");
  assert.equal(githubAppInstallationId({ GITHUB_APP_INSTALLATION_ID: "12x" }), null);
  assert.equal(githubAppInstallationId({}), null);
});

test("resolution prefers the App path when both the App and a static token are configured", async () => {
  const calls = [];
  const resolved = await resolveGithubAccess(roomAppEnv({ GITHUB_TOKEN: "static-token" }), {
    fetchImpl: mintOnlyFetch(calls), nowMs: NOW, appTokenCache: new Map()
  });
  assert.equal(resolved.source, "github_app");
  assert.equal(resolved.token, "fixture-inst-1");
  assert.equal(calls.length, 1, "exactly one mint call");
  assert.equal(calls[0].url, `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
  const jwt = calls[0].authorization.replace(/^Bearer /, "");
  assert.equal(jwt.split(".").length, 3, "the mint authenticates with a three-part App JWT");
  assert.equal(jwt.includes(FIXTURE_PEM), false, "no key material rides the request");
});

test("the mint asks GitHub to narrow the token to the sync's read-only permission set", async () => {
  const calls = [];
  const resolved = await resolveGithubAccess(roomAppEnv(), {
    fetchImpl: mintOnlyFetch(calls), nowMs: NOW, appTokenCache: new Map()
  });
  assert.equal(resolved.source, "github_app");
  assert.equal(calls.length, 1, "exactly one mint call");
  assert.equal(typeof calls[0].body, "string", "the narrowed mint carries a permissions body");
  assert.deepEqual(JSON.parse(calls[0].body), {
    permissions: { checks: "read", contents: "read", metadata: "read", pull_requests: "read" }
  }, "exactly the read set the sync's calls need — no write or admin level anywhere in the set");
});

test("the narrowed cache entry never answers a caller that asked for the full grant", async () => {
  const calls = [];
  const cache = new Map();
  const fetchImpl = mintOnlyFetch(calls);
  const narrowed = await resolveGithubAccess(roomAppEnv(), { fetchImpl, nowMs: NOW, appTokenCache: cache });
  assert.equal(calls.length, 1);
  const full = await installationToken(INSTALLATION_ID, { env: roomAppEnv(), fetchFn: fetchImpl, now: NOW, cache });
  assert.equal(calls.length, 2, "the full-grant caller mints its own token instead of reusing the narrowed one");
  assert.equal(calls[1].body, null, "the full-grant mint sends no permissions body, exactly as before the narrowing existed");
  assert.notEqual(full, narrowed.token);
});

test("a mint refused for its narrowing falls back to the static token, reported by code only", async () => {
  let sawNarrowing = false;
  const fetchImpl = async (url, init = {}) => {
    if (!String(url).startsWith("https://api.github.com/app/installations/")) {
      throw new Error(`unexpected fetch in narrowing stub: ${url}`);
    }
    if (typeof init.body === "string" && init.body.includes("permissions")) {
      sawNarrowing = true;
      return jsonResponse({ status: 403, body: { message: "permissions narrowing refused" } });
    }
    return jsonResponse({
      status: 201,
      body: { token: "fixture-full-grant", expires_at: new Date(NOW + 3_600_000).toISOString() }
    });
  };
  const resolved = await resolveGithubAccess(roomAppEnv({ GITHUB_TOKEN: "static-token" }), {
    fetchImpl, nowMs: NOW, appTokenCache: new Map()
  });
  assert.equal(sawNarrowing, true, "the refusal was triggered by the narrowed mint, not a generic mint failure");
  assert.equal(resolved.source, "env_token");
  assert.equal(resolved.token, "static-token");
  assert.equal(resolved.appError, "token_failed");
  assert.equal(JSON.stringify({ source: resolved.source, appError: resolved.appError }).includes("static-token"), false,
    "the reportable fields name the source and the failure code, never a credential value");
});

test("the minted token is cached across ticks and re-minted inside the expiry skew", async () => {
  const calls = [];
  const cache = new Map();
  const fetchImpl = mintOnlyFetch(calls);
  const first = await resolveGithubAccess(roomAppEnv(), { fetchImpl, nowMs: NOW, appTokenCache: cache });
  const second = await resolveGithubAccess(roomAppEnv(), { fetchImpl, nowMs: NOW + 50 * 60_000, appTokenCache: cache });
  assert.equal(second.token, first.token, "a tick inside the cached window reuses the token");
  assert.equal(calls.length, 1);
  const third = await resolveGithubAccess(roomAppEnv(), { fetchImpl, nowMs: NOW + 56 * 60_000, appTokenCache: cache });
  assert.equal(calls.length, 2, "past expiry minus the 5 minute skew the resolver mints again");
  assert.notEqual(third.token, first.token);
});

test("a refused mint falls back to the static token and names the failure by code only", async () => {
  const calls = [];
  const resolved = await resolveGithubAccess(roomAppEnv({ GITHUB_TOKEN: "static-token" }), {
    fetchImpl: mintOnlyFetch(calls, { failStatus: 403 }), nowMs: NOW, appTokenCache: new Map()
  });
  assert.equal(resolved.source, "env_token");
  assert.equal(resolved.token, "static-token");
  assert.equal(resolved.appError, "token_failed");
  assert.equal(JSON.stringify({ source: resolved.source, appError: resolved.appError }).includes("static-token"), false,
    "the reportable fields name the source and the failure code, never a credential value");
});

test("with no App configuration the static token resolves without any fetch", async () => {
  let fetched = false;
  const resolved = await resolveGithubAccess({ GH_TOKEN: "static-token" }, {
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); }, nowMs: NOW
  });
  assert.deepEqual(resolved, { token: "static-token", source: "env_token" });
  assert.equal(fetched, false);
});

test("with no credential at all the resolver reports none, fetches nothing, and partial App config is named", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; throw new Error("must not fetch"); };
  assert.deepEqual(await resolveGithubAccess({}, { fetchImpl, nowMs: NOW }), { token: null, source: "none" });
  assert.equal(fetched, false);
  const partial = await resolveGithubAccess(
    { ROOM_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, ROOM_GITHUB_APP_ID: "123456" },
    { fetchImpl, nowMs: NOW }
  );
  assert.equal(partial.source, "none");
  assert.equal(partial.token, null);
  assert.equal(partial.appError, "not_configured", "an installation id without credentials is reported, not silently skipped");
});

// --- the sync itself -------------------------------------------------------

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  const hold = (id, number, owner = "grok") => {
    let item = claimWork(createWork({ id }, { now: NOW - 3600000, agentId: owner }), owner, { now: NOW - 3600000, leaseHours: null });
    item = appendWorkPullRequest(item, owner, {
      pullRequest: `https://github.com/Uuriko/project-room/pull/${number}`,
      expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: NOW - 3600000
    });
    registry.set("muse-room", item);
  };
  return { store: { db, workClaims: registry }, registry, hold };
}

const OPEN_PULL = number => ({
  number, state: "open", merged: false,
  html_url: `https://github.com/Uuriko/project-room/pull/${number}`,
  url: `https://api.github.com/repos/Uuriko/project-room/pulls/${number}`,
  base: { repo: { full_name: "Uuriko/project-room" } },
  head: { sha: "a".repeat(40) }
});

function githubRouter(calls) {
  return async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, authorization: init.headers?.Authorization ?? null, body: init.body ?? null });
    if (target.startsWith("https://api.github.com/app/installations/")) {
      return jsonResponse({ status: 201, body: { token: "fixture-inst-1", expires_at: new Date(NOW + 3_600_000).toISOString() } });
    }
    const pull = target.match(/^https:\/\/api\.github\.com\/repos\/Uuriko\/project-room\/pulls\/(\d+)$/);
    if (pull) return jsonResponse({ body: OPEN_PULL(Number(pull[1])) });
    if (target.includes("/status")) return jsonResponse({ body: { state: "success", total_count: 0, statuses: [] } });
    if (target.includes("/check-runs")) return jsonResponse({ body: { total_count: 0, check_runs: [] } });
    throw new Error(`unexpected fetch in router: ${target}`);
  };
}

test("a sync tick mints through the App and polls with the installation token, naming the source", async () => {
  const { store, hold } = setup();
  hold("app-claim", 2479);
  const calls = [];
  const out = await syncClaimPullRequests(store, { env: roomAppEnv(), fetchImpl: githubRouter(calls), nowMs: NOW });
  assert.equal(out.githubAuthSource, "github_app");
  assert.equal(out.checked, 1);
  const mint = calls.find(call => call.url.includes("/app/installations/"));
  assert.ok(mint, "the tick minted through the App");
  assert.deepEqual(JSON.parse(mint.body), {
    permissions: { checks: "read", contents: "read", metadata: "read", pull_requests: "read" }
  }, "the tick's token was minted narrowed to read-only, and the tick still completed with it");
  const poll = calls.find(call => call.url.includes("/pulls/2479"));
  assert.ok(poll, "the pull lookup ran");
  assert.equal(poll.authorization, "Bearer fixture-inst-1", "the poll carries the minted installation token");
  assert.equal(JSON.stringify(out).includes("fixture-inst-1"), false, "the tick summary never carries the token");
});

test("a sync tick with no credential polls unauthenticated and reports source none", async () => {
  const { store, hold } = setup();
  hold("anon-claim", 2480);
  const calls = [];
  const out = await syncClaimPullRequests(store, { env: {}, fetchImpl: githubRouter(calls), nowMs: NOW });
  assert.equal(out.githubAuthSource, "none");
  assert.equal(out.checked, 1, "a missing credential does not fail the tick");
  assert.equal(calls.some(call => call.url.includes("/app/installations/")), false, "no mint is attempted");
  const poll = calls.find(call => call.url.includes("/pulls/2480"));
  assert.ok(poll, "the pull lookup still ran");
  assert.equal(poll.authorization, null, "the poll goes out with no Authorization header");
});
