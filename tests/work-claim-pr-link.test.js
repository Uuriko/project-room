// A claim can carry a GitHub pull request URL. There is no inbound webhook
// receiver, so POST /work-claims/sweep and the claim-pr cron poll the pull.
// A merge completes the claim; a close without a merge releases it. Either
// path appends one work_claim.updated event that names the pull and the outcome.
// applyPullRequestWebhook is the same settlement a pull_request webhook would call.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { applyPullRequestWebhook, syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import { pullRequestOutcomeFromWebhook } from "../server/claim-coordination.mjs";

const URL_A = "https://github.com/Uuriko/project-room/pull/7";

function githubFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (endpoint) => {
    calls.push(endpoint);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

async function room(t) {
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
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
    fetchPullRequest: extra.fetchImpl,
    githubToken: null,
  });
  return { store, call };
}

const claimEvents = store => store.db.prepare(
  "SELECT body FROM events WHERE room_id=? ORDER BY sequence"
).all("commons").map(row => JSON.parse(row.body)).filter(event => event.type === "work_claim.updated");

test("a webhook close and a polled pull reduce to the same outcomes", () => {
  assert.equal(pullRequestOutcomeFromWebhook({ action: "opened", pull_request: { html_url: URL_A, merged: false } }), null);
  assert.equal(pullRequestOutcomeFromWebhook({ action: "closed", pull_request: { html_url: URL_A + "?utm=1", merged: true } }), null);
  const merged = pullRequestOutcomeFromWebhook({ action: "closed", pull_request: { html_url: URL_A, merged: true, state: "closed" } });
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.url, URL_A);
  const closed = pullRequestOutcomeFromWebhook({ action: "closed", pull_request: { html_url: URL_A + "/", merged: false } });
  assert.equal(closed.outcome, "closed");
});

test("polling a merged pull completes the claim and the room event says so", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "lane", title: "Lane", files: ["server/a.mjs"], pullRequest: URL_A, reviewPolicy: "distinct_member" });
  await call("claim", "lane", {});
  const { fetchImpl } = githubFetch({ merged: true, state: "closed" });
  const swept = await call("sweep", null, {}, { fetchImpl });
  assert.equal(swept.value.pullRequests.updated, 1);
  const item = store.workClaims.get("commons", "lane");
  assert.equal(item.state, "done");
  assert.equal(item.deliveryMode, "merged");
  assert.equal(item.pullRequest.outcome, "merged");
  assert.equal(item.reviewPolicy, "distinct_member");
  const [settled] = claimEvents(store).filter(event => event.data.action === "pr_merged");
  assert.equal(settled.actorId, "owner");
  assert.equal(settled.data.claimState, "done");
  assert.deepEqual(settled.data.pullRequest, { url: URL_A, outcome: "merged" });
  assert.deepEqual(settled.data.paths, ["server/a.mjs"]);
});

test("a closing webhook releases the claim, and a second delivery does not settle it again", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "lane", files: ["docs/a.md"], pullRequest: URL_A });
  await call("claim", "lane", {});
  const payload = { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } };
  const first = applyPullRequestWebhook(store, payload);
  assert.deepEqual(first.applied, [{ roomId: "commons", claimId: "lane", outcome: "closed" }]);
  const item = store.workClaims.get("commons", "lane");
  assert.equal(item.state, "unclaimed");
  assert.equal(item.owner, null);
  assert.deepEqual(item.files, []);
  assert.equal(item.pullRequest.outcome, "closed");
  const [settled] = claimEvents(store).filter(event => event.data.action === "pr_closed");
  assert.equal(settled.data.claimState, "unclaimed");
  assert.equal(settled.data.previousOwnerId, "owner");
  assert.deepEqual(settled.data.pullRequest, { url: URL_A, outcome: "closed" });
  assert.deepEqual(settled.data.paths, ["docs/a.md"]);
  assert.deepEqual(applyPullRequestWebhook(store, payload).applied, []);
});

test("an open pull is not settled, and the next sweep waits instead of polling again", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "lane", pullRequest: URL_A });
  await call("claim", "lane", {});
  const { fetchImpl, calls } = githubFetch({ merged: false, state: "open" });
  await call("sweep", null, {}, { fetchImpl });
  await call("sweep", null, {}, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(store.workClaims.get("commons", "lane").state, "claimed");
  assert.equal(store.workClaims.get("commons", "lane").pullRequest.outcome, null);
  assert.equal(claimEvents(store).some(event => event.data.action === "pr_merged" || event.data.action === "pr_closed"), false);
});

test("the cron poll completes a linked claim the same way a sweep does", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "cron-lane", pullRequest: "https://github.com/Uuriko/project-room/pull/8" });
  await call("claim", "cron-lane", {});
  const { fetchImpl } = githubFetch({ merged: true, state: "closed" });
  const result = await syncClaimPullRequests(store, { fetchImpl, token: null });
  assert.equal(result.updated, 1);
  assert.equal(store.workClaims.get("commons", "cron-lane").state, "done");
  assert.equal(claimEvents(store).at(-1).data.action, "pr_merged");
});

test("a GitHub 403 backs off every open pull until the reset, and the next tick does not call again", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "quiet" });
  await call("claim", "quiet", {});
  await call("create", null, { id: "waiting", pullRequest: "https://github.com/Uuriko/project-room/pull/11" });
  await call("create", null, { id: "lane", pullRequest: URL_A });
  await call("claim", "lane", {});
  await call("create", null, { id: "other", pullRequest: "https://github.com/Uuriko/project-room/pull/9" });
  await call("claim", "other", {});
  const nowMs = Date.parse("2026-10-01T12:00:00Z");
  const resetMs = nowMs + 30 * 60_000;
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push({ endpoint, headers: init?.headers ?? {} });
    return {
      ok: false,
      status: 403,
      headers: { get(name) {
        if (name.toLowerCase() === "x-ratelimit-remaining") return "0";
        if (name.toLowerCase() === "x-ratelimit-reset") return String(resetMs / 1000);
        return null;
      } },
      text: async () => "{\"message\":\"API rate limit exceeded\"}",
    };
  };
  const first = await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs });
  assert.equal(first.rateLimited, true);
  assert.equal(calls.length, 1, "one unauthenticated lookup per tick");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.doesNotMatch(calls[0].endpoint, /\/pulls\/11$/);
  assert.equal(store.workClaims.get("commons", "lane").pullRequest.rateLimitedUntil, resetMs);
  assert.equal(store.workClaims.get("commons", "other").pullRequest.rateLimitedUntil, resetMs);
  assert.equal(store.workClaims.get("commons", "waiting").state, "unclaimed");
  assert.equal(store.workClaims.get("commons", "waiting").pullRequest.rateLimitedUntil, null);
  const second = await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs: nowMs + 60_000 });
  assert.equal(second.checked, 0);
  assert.equal(second.rateLimited, true);
  assert.equal(calls.length, 1);
});

test("an open pull sends If-None-Match, and a 304 keeps the claim", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "lane", pullRequest: URL_A });
  await call("claim", "lane", {});
  const nowMs = Date.parse("2026-10-01T12:00:00Z");
  const calls = [];
  const fetchImpl = async (_endpoint, init) => {
    calls.push(init?.headers ?? {});
    if (calls.length === 1) {
      return {
        ok: true, status: 200,
        headers: { get: name => name.toLowerCase() === "etag" ? 'W/"pull-1"' : null },
        text: async () => "{\"merged\":false,\"state\":\"open\"}",
      };
    }
    return {
      ok: false, status: 304,
      headers: { get: name => name.toLowerCase() === "etag" ? 'W/"pull-1"' : null },
      text: async () => "",
    };
  };
  await syncClaimPullRequests(store, { fetchImpl, env: { GITHUB_TOKEN: "ghs_test" }, nowMs });
  assert.equal(calls[0].Authorization, "Bearer ghs_test");
  assert.equal(calls[0]["If-None-Match"], undefined);
  await syncClaimPullRequests(store, { fetchImpl, env: { GITHUB_TOKEN: "ghs_test" }, nowMs: nowMs + 60_000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]["If-None-Match"], 'W/"pull-1"');
  assert.equal(store.workClaims.get("commons", "lane").state, "claimed");
  assert.equal(store.workClaims.get("commons", "lane").pullRequest.outcome, null);
});

test("a cron deadline does not call GitHub and does not start a second lookup", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "lane", pullRequest: URL_A });
  await call("claim", "lane", {});
  await call("create", null, { id: "other", pullRequest: "https://github.com/Uuriko/project-room/pull/9" });
  await call("claim", "other", {});
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 300));
    return { ok: true, status: 200, text: async () => "{\"merged\":false,\"state\":\"open\"}" };
  };
  const blocked = await syncClaimPullRequests(store, { fetchImpl, token: "ghs_test", deadline: Date.now() - 1 });
  assert.equal(blocked.budgetExceeded, 1);
  assert.equal(blocked.checked, 0);
  assert.equal(calls, 0);
  assert.equal(store.workClaims.get("commons", "lane").state, "claimed");
  const started = Date.now();
  const partial = await syncClaimPullRequests(store, {
    fetchImpl, token: "ghs_test", deadline: started + 150, yieldBetween: async () => {}
  });
  assert.equal(calls, 1);
  assert.equal(partial.budgetExceeded, 1);
  assert.equal(partial.checked, 1);
  assert.equal(store.workClaims.get("commons", "lane").pullRequest.outcome, null);
  assert.equal(store.workClaims.get("commons", "other").pullRequest.etag ?? null, null);
});
