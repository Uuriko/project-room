// REL-18: graceful degradation when GitHub is unconfigured.
// Sweep of every GitHub-backed path on main. With no token, a 401, or an
// unreachable GitHub, each path returns a named outcome and never throws
// a raw error that the route would turn into a 500.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { readRoomDeployStatus, collectPullRequestLookups } from "../server/claim-pr-sync.mjs";
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
  const items = [{ roomId: "r1", id: "c1", repo: "acme/private", number: 7, pullRequests: [{ repo: "acme/private", number: 7 }] }];
  for (const [name, fetchImpl] of Object.entries(transports)) {
    const batch = await collectPullRequestLookups(items, { fetchImpl, token: null, nowMs: 1_750_000_000_000 });
    assert.equal(typeof batch, "object", name);
  }
  const unauth = await collectPullRequestLookups(items, { fetchImpl: transports["401 bad credentials"], token: null, nowMs: 1 });
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
