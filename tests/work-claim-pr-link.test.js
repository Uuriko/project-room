// A claim can carry a GitHub pull request URL. There is no inbound webhook
// receiver, so POST /work-claims/sweep and the claim-pr cron poll the pull.
// A merge completes the claim; a close without a merge releases it. Either
// path appends one work_claim.updated event that names the pull and the outcome.
// applyPullRequestWebhook is the same settlement a pull_request webhook would call.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims, closeWorkClaim } from "../server/work-claim-routes.mjs";
import { applyPullRequestWebhook, syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import { pullRequestOutcomeFromWebhook } from "../server/claim-coordination.mjs";
// SEC-2: claim reads carry content-trust markers; compare the claim itself.
const stripTrust = value => JSON.parse(JSON.stringify(value, (key, entry) => (key === "untrusted" || key === "contentTrust" ? undefined : entry)));

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
    auth: extra.auth ?? { member: { id: "owner", kind: "human", permissions: [] } },
    reauthorize: extra.reauthorize,
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

// Authoring gate: the real route/storage/event boundary owns attach-after-claim.
// A dropped update alternative, unconditional write, or weaker CAS breaks this
// journey. Existing create-time PR tests cannot reach the missing transition.
test("linking a draft after claiming preserves the lease and reconciles exact duplicates", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "later-pr", files: ["src/held.js"], repo: "Uuriko/project-room", branch: "draft" });
  const claimed = (await call("claim", "later-pr", { leaseHours: 1 })).value;
  const body = { appendPullRequest: URL_A + "/", expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  const beforeEvents = claimEvents(store).length;
  const linked = (await call("update", "later-pr", body)).value;
  assert.equal(linked.pullRequests.length, 1);
  assert.equal(linked.pullRequest.url, URL_A);
  assert.equal(linked.pullRequest.outcome, null);
  assert.equal(linked.ci, null);
  for (const key of ["owner", "state", "claimedAt", "leaseStartAt", "leaseExpiresAt", "files", "fileBlocks", "dependsOn", "repo", "branch", "revision", "deliveryMode"]) {
    assert.deepEqual(linked[key], claimed[key], key);
  }
  assert.equal(linked.history.length, claimed.history.length + 1);
  assert.match(linked.history.at(-1).note, /https:\/\/github\.com\/Uuriko\/project-room\/pull\/7/);
  assert.deepEqual(stripTrust((await call("read", "later-pr")).value), linked);
  assert.equal(claimEvents(store).length, beforeEvents + 1);
  assert.equal(claimEvents(store).at(-1).data.action, "state_changed");
  assert.equal(claimEvents(store).at(-1).data.reason, undefined);
  const stale = await call("update", "later-pr", body);
  assert.equal(stale.status, 409);
  assert.equal(stale.value.error.code, "work_claim_conflict");
  assert.equal(stale.value.next[0].path, "/api/rooms/commons/work-claims/later-pr");
  const repeated = (await call("update", "later-pr", { ...body, expectedHistoryLength: linked.history.length })).value;
  assert.deepEqual(repeated, linked);
  assert.equal(claimEvents(store).length, beforeEvents + 1);
  assert.deepEqual(store.workClaims.get("commons", "later-pr"), linked);
});

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

test("a batch stays claimed until every linked pull is merged or closed", async t => {
  const { store, call } = await room(t);
  const second = "https://github.com/Uuriko/project-room/pull/9";
  await call("create", null, { id: "batch", repo: "Uuriko/project-room", branch: "coord", files: ["src/batch.mjs"] });
  let current = (await call("claim", "batch", {})).value;
  for (const appendPullRequest of [URL_A, second]) {
    current = (await call("update", "batch", { appendPullRequest, expectedClaimedAt: current.claimedAt, expectedHistoryLength: current.history.length })).value;
  }
  const firstFetch = githubFetch({ merged: true, state: "closed" });
  await call("sweep", null, {}, { fetchImpl: firstFetch.fetchImpl });
  const midway = store.workClaims.get("commons", "batch");
  assert.equal(midway.state, "claimed");
  assert.equal(midway.repo, "Uuriko/project-room");
  assert.equal(midway.branch, "coord");
  assert.equal(midway.pullRequests.find(pull => pull.url === URL_A).outcome, "merged");
  assert.equal(midway.pullRequests.find(pull => pull.url === second).outcome, null);
  assert.equal(midway.pullRequest.url, second);
  assert.equal(claimEvents(store).some(event => event.data.action === "pr_merged"), false);
  const closedFetch = githubFetch({ merged: false, state: "closed" });
  await call("sweep", null, {}, { fetchImpl: closedFetch.fetchImpl });
  const settled = store.workClaims.get("commons", "batch");
  // #1518: a merged link is authoritative evidence of done — the closed
  // link cannot veto it, so the batch settles pr_merged, not pr_closed.
  assert.equal(settled.state, "done");
  assert.equal(settled.pullRequests.every(pull => pull.outcome), true);
  assert.equal(claimEvents(store).some(event => event.data.action === "pr_merged"), true);
});

test("an explicit release settles a batch while a linked pull is still open", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "open-batch", files: ["src/open-batch.mjs"], pullRequests: [URL_A, "https://github.com/Uuriko/project-room/pull/11"] });
  await call("claim", "open-batch", {});
  const released = await call("release", "open-batch", { reason: "handed off" });
  assert.equal(released.value.state, "unclaimed");
  assert.equal(store.workClaims.get("commons", "open-batch").owner, null);
});

test("an open pull is not settled, and the next sweep waits instead of polling again", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "lane", pullRequest: URL_A, files: ["src/lane.mjs"] });
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
  await call("create", null, { id: "cron-lane", pullRequest: "https://github.com/Uuriko/project-room/pull/8", files: ["src/cron-lane.mjs"] });
  await call("claim", "cron-lane", {});
  const { fetchImpl } = githubFetch({ merged: true, state: "closed" });
  const result = await syncClaimPullRequests(store, { fetchImpl, token: null });
  assert.equal(result.updated, 1);
  assert.equal(store.workClaims.get("commons", "cron-lane").state, "done");
  assert.equal(claimEvents(store).at(-1).data.action, "pr_merged");
});

test("a GitHub 403 backs off every open pull until the reset, and the next tick does not call again", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "quiet", files: ["src/quiet.mjs"] });
  await call("claim", "quiet", {});
  await call("create", null, { id: "waiting", pullRequest: "https://github.com/Uuriko/project-room/pull/11", files: ["src/waiting.mjs"] });
  await call("create", null, { id: "lane", pullRequest: URL_A, files: ["src/lane.mjs"] });
  await call("claim", "lane", {});
  await call("create", null, { id: "other", pullRequest: "https://github.com/Uuriko/project-room/pull/9", files: ["src/other.mjs"] });
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
  await call("create", null, { id: "lane", pullRequest: URL_A, files: ["src/lane.mjs"] });
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
  await call("create", null, { id: "lane", pullRequest: URL_A, files: ["src/lane.mjs"] });
  await call("claim", "lane", {});
  await call("create", null, { id: "other", pullRequest: "https://github.com/Uuriko/project-room/pull/9", files: ["src/other.mjs"] });
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

// Claim lifecycle on the real store: REST close and the MCP closeWorkClaim
// path both land the terminal closed state and append one validated
// work_claim.updated event (action closed, reason closed|cancelled).
test("close and cancel append a validated closed event on the real store, REST and MCP alike", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "retire-rest" });
  await call("create", null, { id: "retire-mcp" });
  const before = claimEvents(store).length;
  const closed = (await call("close", "retire-rest", { reason: "stale" })).value;
  assert.equal(closed.state, "closed");
  const auth = { member: { id: "owner", kind: "human", permissions: [] } };
  const cancelled = closeWorkClaim({ store, roomId: "commons", auth, claimId: "retire-mcp", verb: "cancel", reason: "duplicate" });
  assert.equal(cancelled.state, "closed");
  assert.equal(store.workClaims.get("commons", "retire-mcp").history.at(-1).action, "cancelled");
  const events = claimEvents(store).slice(before);
  assert.deepEqual(events.map(event => [event.data.workClaim, event.data.action, event.data.claimState, event.data.reason]),
    [["retire-rest", "closed", "closed", "closed"], ["retire-mcp", "closed", "closed", "cancelled"]]);
  assert.throws(() => closeWorkClaim({ store, roomId: "commons", auth, claimId: "retire-mcp", verb: "close" }),
    error => error.status === 409 && error.code === "work_claim_terminal");
});

// Distinct storage contract: a common read permits one append, and the losing
// writer must reconcile before adding its own URL. No link or event is lost.
test("concurrent PR attachments serialize and invalid update alternatives cannot write", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "concurrent", files: ["src/concurrent.mjs"] });
  const claim = (await call("claim", "concurrent", {})).value;
  const basis = { expectedClaimedAt: claim.claimedAt, expectedHistoryLength: claim.history.length };
  const urls = [URL_A, "https://github.com/Uuriko/project-room/pull/12"];
  const results = await Promise.all(urls.map(appendPullRequest => call("update", "concurrent", { ...basis, appendPullRequest })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  let current = store.workClaims.get("commons", "concurrent");
  const missing = urls.find(url => !current.pullRequests.some(pull => pull.url === url));
  current = (await call("update", "concurrent", { ...basis, expectedHistoryLength: current.history.length, appendPullRequest: missing })).value;
  assert.deepEqual(new Set(current.pullRequests.map(pull => pull.url)), new Set(urls));
  const eventsBefore = claimEvents(store);
  for (const extra of [{ state: "done" }, { note: "do more" }, { pullRequests: [] }, { ci: { state: "success" } }, { leaseHours: 12 }]) {
    await assert.rejects(call("update", "concurrent", { ...basis, expectedHistoryLength: current.history.length, appendPullRequest: URL_A, ...extra }), error => error.status === 422 && error.code === "invalid_claim_input");
  }
  assert.deepEqual(store.workClaims.get("commons", "concurrent"), current);
  assert.deepEqual(claimEvents(store), eventsBefore);
});

test("PR link and event roll back together, and expiry or archived rooms cannot mutate", async t => {
  const { store, call } = await room(t);
  const now = Date.parse("2026-10-03T13:00:00Z");
  store.now = () => now;
  await call("create", null, { id: "atomic", files: ["src/atomic.mjs"] });
  await call("claim", "atomic", { leaseHours: 1 });
  const claimed = store.workClaims.get("commons", "atomic");
  const input = { appendPullRequest: URL_A, expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  const eventsBefore = claimEvents(store);
  store.db.exec("CREATE TEMP TRIGGER refuse_claim_link_event BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'work_claim.updated' BEGIN SELECT RAISE(ABORT, 'event storage refused'); END");
  await assert.rejects(call("update", "atomic", input), /event storage refused/);
  assert.deepEqual(store.workClaims.get("commons", "atomic"), claimed);
  assert.deepEqual(claimEvents(store), eventsBefore);
  store.db.exec("DROP TRIGGER refuse_claim_link_event");
  store.now = () => now + 6 * 3600000;
  const expired = await call("update", "atomic", input);
  assert.equal(expired.status, 409);
  assert.equal(expired.value.error.code, "claim_lease_lapsed");
  assert.equal(expired.value.next[0].path, "/api/rooms/commons/work-claims/atomic");
  assert.deepEqual(store.workClaims.get("commons", "atomic"), claimed);
  assert.deepEqual(claimEvents(store), eventsBefore);
  store.now = () => now;
  const token = store.issueAccessKey("commons", "owner");
  store.command(token, "commons", { id: "archive-link-room", type: "room.archived", data: { reason: "finished" } });
  await assert.rejects(call("update", "atomic", input), error => error.status === 409 && error.code === "room_archived");
  assert.deepEqual(store.workClaims.get("commons", "atomic"), claimed);
  assert.deepEqual(claimEvents(store), eventsBefore);
});

// Authoring gate: re-linking a settled PR URL in a new claim round must
// reset the link for re-polling. Round 1's "closed" outcome belongs to
// round 1; a silent no-op would leave pullRequestDue false forever, so the
// reopened PR is never re-polled and the new round can never settle via
// it. No existing pr-link test covers a second round re-linking the same URL.
test("re-linking a settled PR URL in a new round resets the link for re-polling", async t => {
  const { store, call } = await room(t);
  await call("create", null, { id: "relink-pr", title: "relink" });
  const claimed = (await call("claim", "relink-pr", {})).value;
  const linked = (await call("update", "relink-pr", {
    appendPullRequest: URL_A,
    expectedClaimedAt: claimed.claimedAt,
    expectedHistoryLength: claimed.history.length,
  })).value;
  assert.equal(linked.pullRequests.length, 1);
  assert.equal(linked.pullRequest.outcome, null);

  // Round 1 ends: the PR closes unmerged, the claim is released (pr_closed).
  applyPullRequestWebhook(store, {
    action: "closed",
    pull_request: { html_url: URL_A, merged: false, state: "closed" },
  });
  const released = store.workClaims.get("commons", "relink-pr");
  assert.equal(released.state, "unclaimed");
  assert.equal(released.pullRequests[0].outcome, "closed");

  // Round 2: a new claim round re-links the same PR (it was reopened).
  const round2 = (await call("claim", "relink-pr", {})).value;
  assert.notEqual(round2.claimedAt, claimed.claimedAt);
  const relinked = (await call("update", "relink-pr", {
    appendPullRequest: URL_A,
    expectedClaimedAt: round2.claimedAt,
    expectedHistoryLength: round2.history.length,
  })).value;
  assert.equal(relinked.pullRequests.length, 1);
  assert.equal(relinked.pullRequests[0].url, URL_A);
  assert.equal(relinked.pullRequests[0].outcome, null,
    "a re-link in a new round must drop the previous round's settled outcome so the poller re-reads the PR");
  assert.equal(relinked.pullRequest.url, URL_A);
  assert.equal(relinked.pullRequest.outcome, null);
  assert.equal(relinked.history.at(-1).action, "pr_linked");
  assert.match(relinked.history.at(-1).note, /pull\/7/);
  assert.deepEqual(store.workClaims.get("commons", "relink-pr").pullRequests[0].outcome, null);
});

// Regression: the previous round's outcome and the next claim can share a
// millisecond (webhook + re-claim in the same tick). Equal timestamps must
// still read as a stale outcome, or the closed link survives the re-link.
test("re-linking resets a settled PR even when syncedAt equals claimedAt", async t => {
  const { store, call } = await room(t);
  const now = Date.parse("2026-10-03T13:00:00Z");
  store.now = () => now;
  await call("create", null, { id: "relink-same-ms", title: "relink" });
  const claimed = (await call("claim", "relink-same-ms", {})).value;
  await call("update", "relink-same-ms", { appendPullRequest: URL_A, expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length });
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } }, { nowMs: now });
  const released = store.workClaims.get("commons", "relink-same-ms");
  assert.equal(released.pullRequests[0].outcome, "closed");
  const round2 = (await call("claim", "relink-same-ms", {})).value;
  assert.equal(round2.pullRequests[0].syncedAt, round2.claimedAt, "fixture must force syncedAt == claimedAt");
  const relinked = (await call("update", "relink-same-ms", { appendPullRequest: URL_A, expectedClaimedAt: round2.claimedAt, expectedHistoryLength: round2.history.length })).value;
  assert.equal(relinked.pullRequests[0].outcome, null);
  assert.equal(relinked.history.at(-1).action, "pr_linked");
});

// Regression (adversarial challenge of #2010): the tie-break must not count
// "claimed" stamps alone. A round that begins via reassign stamps
// "reassigned:<target>", never "claimed" — the old count saw only one round
// and a same-millisecond settle+reclaim tie was misread as current-round
// truth, so the stale "closed" outcome survived and vetoed every future poll.
test("re-linking resets a same-ms tie when the first round began via reassign", async t => {
  const { store, call } = await room(t);
  const now = Date.parse("2026-10-03T13:00:00Z");
  store.now = () => now;
  await call("create", null, { id: "relink-reassign-ms", title: "relink" });
  const assigned = (await call("reassign", "relink-reassign-ms", { newOwner: "owner" })).value;
  assert.equal(assigned.state, "claimed");
  assert.equal(assigned.history.at(-1).action, "reassigned:owner");
  assert.ok(!assigned.history.some(entry => entry.action === "claimed"), "reassign starts the round without a claimed stamp");
  await call("update", "relink-reassign-ms", { appendPullRequest: URL_A, expectedClaimedAt: assigned.claimedAt, expectedHistoryLength: assigned.history.length });
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } }, { nowMs: now });
  const released = store.workClaims.get("commons", "relink-reassign-ms");
  assert.equal(released.pullRequests[0].outcome, "closed");
  assert.equal(released.pullRequests[0].syncedAt, released.claimedAt, "fixture must force syncedAt == claimedAt");
  const round2 = (await call("claim", "relink-reassign-ms", {})).value;
  const relinked = (await call("update", "relink-reassign-ms", { appendPullRequest: URL_A, expectedClaimedAt: round2.claimedAt, expectedHistoryLength: round2.history.length })).value;
  assert.equal(relinked.pullRequests[0].outcome, null,
    "the pr_closed stamp proves a previous round ended, so the tie is stale");
  assert.equal(relinked.history.at(-1).action, "pr_linked");
});

// Regression (adversarial challenge of #2010): history trimming
// (MAX_CLAIM_HISTORY) can drop early "claimed" stamps. A same-millisecond tie
// on a long-lived claim must still read as stale — the round-ending stamp is
// recent and survives trimming.
test("re-linking resets a same-ms tie even when early claimed stamps were trimmed", async t => {
  const { store, call } = await room(t);
  const now = Date.parse("2026-10-03T13:00:00Z");
  store.now = () => now;
  await call("create", null, { id: "relink-trimmed-ms", title: "relink" });
  const claimed = (await call("claim", "relink-trimmed-ms", {})).value;
  await call("update", "relink-trimmed-ms", { appendPullRequest: URL_A, expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length });
  for (let n = 0; n < 210; n++) await call("update", "relink-trimmed-ms", { note: `filler ${n}` });
  const trimmed = store.workClaims.get("commons", "relink-trimmed-ms");
  assert.ok(trimmed.historyOmitted > 0, "fixture must trim history");
  assert.ok(!trimmed.history.some(entry => entry.action === "claimed"), "round-1 claimed stamp must be trimmed away");
  applyPullRequestWebhook(store, { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } }, { nowMs: now });
  const released = store.workClaims.get("commons", "relink-trimmed-ms");
  assert.equal(released.pullRequests[0].outcome, "closed");
  const round2 = (await call("claim", "relink-trimmed-ms", {})).value;
  const item = store.workClaims.get("commons", "relink-trimmed-ms");
  const relinked = (await call("update", "relink-trimmed-ms", { appendPullRequest: URL_A, expectedClaimedAt: round2.claimedAt, expectedHistoryLength: item.history.length + (item.historyOmitted ?? 0) })).value;
  assert.equal(relinked.pullRequests[0].outcome, null,
    "the recent pr_closed stamp survives trimming and proves the tie is stale");
  assert.equal(relinked.history.at(-1).action, "pr_linked");
});

// Tie behavior, N-way: three rounds settling at the same frozen millisecond
// each reset on re-link — including a link that was already reset once and
// re-settled by a duplicate webhook delivery.
test("re-linking resets same-ms ties across three claim rounds", async t => {
  const { store, call } = await room(t);
  const now = Date.parse("2026-10-03T13:00:00Z");
  store.now = () => now;
  await call("create", null, { id: "relink-three-ms", title: "relink" });
  const r1 = (await call("claim", "relink-three-ms", {})).value;
  await call("update", "relink-three-ms", { appendPullRequest: URL_A, expectedClaimedAt: r1.claimedAt, expectedHistoryLength: r1.history.length });
  const webhook = { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } };
  applyPullRequestWebhook(store, webhook, { nowMs: now });
  const r2 = (await call("claim", "relink-three-ms", {})).value;
  const relinked2 = (await call("update", "relink-three-ms", { appendPullRequest: URL_A, expectedClaimedAt: r2.claimedAt, expectedHistoryLength: r2.history.length })).value;
  assert.equal(relinked2.pullRequests[0].outcome, null, "round-2 re-link resets");
  applyPullRequestWebhook(store, webhook, { nowMs: now });
  assert.equal(store.workClaims.get("commons", "relink-three-ms").pullRequests[0].outcome, "closed");
  const r3 = (await call("claim", "relink-three-ms", {})).value;
  const relinked3 = (await call("update", "relink-three-ms", { appendPullRequest: URL_A, expectedClaimedAt: r3.claimedAt, expectedHistoryLength: r3.history.length })).value;
  assert.equal(relinked3.pullRequests[0].outcome, null, "round-3 re-link resets");
  assert.equal(relinked3.history.at(-1).action, "pr_linked");
});

// Tie behavior across rooms: one webhook settles the same PR URL in two rooms
// at the same millisecond. Each room's re-link is independent — resetting
// room A must not disturb room B's settled link.
test("same-ms ties in two rooms reset independently", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("second"));
  t.after(() => store.close());
  const now = Date.parse("2026-10-03T13:00:00Z");
  store.now = () => now;
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const forRoom = roomId => (route, id, body) => handleWorkClaims({
    req: { method: "POST", body }, res: {},
    url: new URL(`https://room.example/api/rooms/${roomId}/work-claims`),
    store, roomId,
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims, githubToken: null,
  });
  const callA = forRoom("commons"), callB = forRoom("second");
  const link = item => ({ appendPullRequest: URL_A, expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length });
  await callA("create", null, { id: "relink-xroom", title: "relink" });
  const a1 = (await callA("claim", "relink-xroom", {})).value;
  await callA("update", "relink-xroom", link(a1));
  await callB("create", null, { id: "relink-xroom", title: "relink" });
  const b1 = (await callB("claim", "relink-xroom", {})).value;
  await callB("update", "relink-xroom", link(b1));
  const applied = applyPullRequestWebhook(store,
    { action: "closed", pull_request: { html_url: URL_A, merged: false, state: "closed" } }, { nowMs: now });
  assert.equal(applied.applied.length, 2, "webhook settles both rooms");
  const a2 = (await callA("claim", "relink-xroom", {})).value;
  const relinkedA = (await callA("update", "relink-xroom", link(a2))).value;
  assert.equal(relinkedA.pullRequests[0].outcome, null, "room A resets");
  assert.equal(store.workClaims.get("second", "relink-xroom").pullRequests[0].outcome, "closed",
    "room B untouched until it re-links");
  const b2 = (await callB("claim", "relink-xroom", {})).value;
  const relinkedB = (await callB("update", "relink-xroom", link(b2))).value;
  assert.equal(relinkedB.pullRequests[0].outcome, null, "room B resets on its own re-link");
});
