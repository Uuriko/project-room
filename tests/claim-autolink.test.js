// plan-pr-autolink: off-room PRs and deploys link back to their board item.
//
// New behavior under test (nothing here existed before this change):
//  1. parseClaimId / findClaimForPull — claim ids are read out of a branch
//     name, an explicit `claim:` marker, the PR title, or the PR body, with a
//     fixed priority (marker > branch > title > body) and an ambiguity guard.
//  2. autoLinkPullRequest — the system (no owner session) attaches a PR URL
//     to a live claim and emits one work_claim.updated receipt.
//  3. handlePrWebhookPayload — a verified pull_request payload auto-links an
//     unlinked PR and settles already-linked claims, with a minimal response.
//  4. discoverUnlinkedPulls — poll fallback: open PRs are matched to claims
//     that carry no PR link yet, skipped for repos with a fresh webhook
//     delivery, and held while the shared GitHub budget is rate-limited.
//  5. linkDeployToSettledClaims — a stamped deploy revision is linked back
//     onto the settled items whose required revision is that deploy.
//  6. prWebhookEnabled / the route handler — the receiver is OFF by default
//     (404), on only with ROOM_PR_WEBHOOK set, and 503 when enabled without
//     its secret (fail closed, never accept unsigned deliveries).
//
// Authoring gate answers: each test guards an observable contract at the
// real boundary (pure matcher, RoomStore write, route handler). The credible
// regressions are a priority inversion in matching, a double-link or a link
// onto a settled claim, an unsigned webhook being honored, and a deploy
// revision landing on the wrong items. Existing suites cover owner-driven
// linking and linked-PR polling, not the system auto-link path.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import {
  parseClaimId,
  findClaimForPull,
  autoLinkPullRequest,
  handlePrWebhookPayload,
  discoverUnlinkedPulls,
  linkDeployToSettledClaims,
  prWebhookEnabled,
  PR_WEBHOOK_FLAG,
  PR_WEBHOOK_SECRET_ENV,
  postPrWebhook,
} from "../server/claim-autolink.mjs";

import { writeClaimPullBudget } from "../server/claim-pr-sync.mjs";

const URL_A = "https://github.com/Uuriko/project-room/pull/7";
const URL_B = "https://github.com/Uuriko/project-room/pull/8";
const REPO = "Uuriko/project-room";

function makeRoom(t, roomId = "commons") {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(roomId));
  t.after(() => store.close());
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL(`https://room.example/api/rooms/${roomId}/work-claims`),
    store, roomId,
    auth: extra.auth ?? { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
  });
  return { store, call, roomId };
}

const claimEvents = (store, roomId) => store.db.prepare(
  "SELECT body FROM events WHERE room_id=? ORDER BY sequence"
).all(roomId).map(row => JSON.parse(row.body)).filter(event => event.type === "work_claim.updated");

async function liveClaim(make, id, extra = {}) {
  const { store, call, roomId } = make;
  await call("create", null, { id, files: [`server/${id}.mjs`], repo: REPO, branch: id, ...extra.create });
  await call("claim", id, { leaseHours: 6 });
  return { store, roomId, id };
}

const prPayload = (overrides = {}) => ({
  action: "opened",
  pull_request: {
    html_url: URL_A,
    head: { ref: "lane-webhook" },
    title: "lane-webhook: wire the thing",
    body: "implements the claim",
    merged: false,
    state: "open",
    ...(overrides.pull_request ?? {}),
  },
  repository: { full_name: REPO },
  ...(overrides.top ?? {}),
});

// --- 1. claim-id parsing -----------------------------------------------

test("parseClaimId: explicit claim marker outranks branch, title and body", () => {
  const found = parseClaimId({
    branch: "u/other-claim",
    title: "title-claim",
    body: "claim: real-claim",
  });
  // "claim" itself is token-shaped and lands as a body candidate; the live
  // claim list filters it out. Priority is what matters here.
  assert.deepEqual(found.map(c => c.id).slice(0, 3), ["real-claim", "other-claim", "title-claim"]);
  assert.equal(found[0].source, "marker");
  assert.equal(found[1].source, "branch");
  assert.equal(found[2].source, "title");
});

test("parseClaimId: branch segments match exactly, partial tokens do not", () => {
  const found = parseClaimId({ branch: "u/jill/plan-pr-autolink", title: "", body: "" });
  // every exact segment is a candidate; matching against live claims filters
  assert.deepEqual(found.map(c => c.id), ["jill", "plan-pr-autolink"]);
  assert.equal(found[1].source, "branch");
  const noisy = parseClaimId({ branch: "u/jill/plan-pr-autolinker", title: "", body: "" });
  assert.deepEqual(noisy.map(c => c.id), ["jill", "plan-pr-autolinker"]);
  // a token that merely contains a claim id never matches it
  const claims = [{ id: "plan-pr-autolink", roomId: "commons", state: "claimed", owner: "owner", repo: "Uuriko/project-room" }];
  assert.equal(
    findClaimForPull({ branch: "u/jill/plan-pr-autolinker", title: "", body: "", repo: "Uuriko/project-room" }, claims),
    null);
});

test("parseClaimId: ignores garbage; tokens are capped at 80 chars", () => {
  assert.deepEqual(parseClaimId({ branch: "", title: "", body: "" }), []);
  assert.deepEqual(parseClaimId({ branch: "!!!", title: "a b", body: "" }), []);
  for (const { id } of parseClaimId({ branch: "", title: "", body: "x".repeat(200) })) {
    assert.ok(id.length <= 80);
  }
});

test("findClaimForPull: branch match links the claim, repo mismatch excludes", () => {
  const claims = [
    { id: "lane-a", roomId: "commons", state: "claimed", owner: "owner", repo: REPO },
    { id: "lane-b", roomId: "commons", state: "claimed", owner: "owner", repo: "Uuriko/other" },
  ];
  const hit = findClaimForPull({ branch: "u/jill/lane-a", title: "", body: "", repo: REPO }, claims);
  assert.equal(hit.claim.id, "lane-a");
  assert.equal(hit.source, "branch");
  const miss = findClaimForPull({ branch: "u/jill/lane-b", title: "", body: "", repo: REPO }, claims);
  assert.equal(miss, null);
});

test("findClaimForPull: two live claims on one token is ambiguous, never a guess", () => {
  const claims = [
    { id: "lane-a", roomId: "commons", state: "claimed", owner: "owner", repo: REPO },
    { id: "lane-a", roomId: "other-room", state: "claimed", owner: "owner", repo: REPO },
  ];
  const found = findClaimForPull({ branch: "lane-a", title: "", body: "", repo: REPO }, claims);
  assert.deepEqual(found.ambiguous, ["commons:lane-a", "other-room:lane-a"]);
});

test("findClaimForPull: done and unclaimed items are not link targets", () => {
  const claims = [
    { id: "lane-a", roomId: "commons", state: "done", owner: "owner", repo: REPO },
    { id: "lane-b", roomId: "commons", state: "unclaimed", owner: null, repo: REPO },
  ];
  assert.equal(findClaimForPull({ branch: "lane-a", title: "", body: "", repo: REPO }, claims), null);
  assert.equal(findClaimForPull({ branch: "lane-b", title: "", body: "", repo: REPO }, claims), null);
});

// --- 2. system auto-link -------------------------------------------------

test("autoLinkPullRequest: links the PR and emits one receipt", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-link");
  const before = claimEvents(make.store, make.roomId).length;
  const out = autoLinkPullRequest(make.store, make.roomId, "lane-link",
    { url: URL_A, source: "branch" }, { nowMs: 1_700_000_000_000 });
  assert.equal(out.linked, true);
  assert.equal(out.claimId, "lane-link");
  const item = make.store.workClaims.get(make.roomId, "lane-link");
  assert.equal(item.pullRequests.length, 1);
  assert.equal(item.pullRequest.url, URL_A);
  assert.equal(item.pullRequest.outcome, null);
  assert.equal(item.state, "claimed");
  assert.equal(item.owner, "owner");
  assert.equal(item.history.at(-1).action, "pr_autolinked");
  assert.match(item.history.at(-1).note, /pull\/7/);
  const events = claimEvents(make.store, make.roomId);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).data.action, "state_changed");
  assert.equal(events.at(-1).data.reason, undefined);
});

test("autoLinkPullRequest: duplicate and settled links are refused", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-dup");
  autoLinkPullRequest(make.store, make.roomId, "lane-dup", { url: URL_A, source: "branch" }, {});
  const again = autoLinkPullRequest(make.store, make.roomId, "lane-dup", { url: URL_A, source: "branch" }, {});
  assert.equal(again.linked, false);
  assert.equal(again.reason, "already_linked");
  const other = autoLinkPullRequest(make.store, make.roomId, "lane-dup", { url: URL_B, source: "title" }, {});
  assert.equal(other.linked, false);
  assert.equal(other.reason, "open_link_exists");
  const item = make.store.workClaims.get(make.roomId, "lane-dup");
  assert.equal(item.pullRequests.length, 1);
});

test("autoLinkPullRequest: refuses settled and unclaimed items", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-settled");
  const settled = autoLinkPullRequest(make.store, make.roomId, "lane-settled", { url: URL_A, source: "branch" }, {});
  assert.equal(settled.linked, true);
  // settle it via the existing webhook path, then auto-link must refuse
  handlePrWebhookPayload(make.store,
    prPayload({ top: { action: "closed" }, pull_request: { head: { ref: "lane-settled" }, merged: true, state: "closed" } }), {});
  const done = make.store.workClaims.get(make.roomId, "lane-settled");
  assert.equal(done.state, "done");
  const refused = autoLinkPullRequest(make.store, make.roomId, "lane-settled", { url: URL_B, source: "branch" }, {});
  assert.equal(refused.linked, false);
  assert.equal(refused.reason, "not_active");
});

// --- 3. webhook core -----------------------------------------------------

test("handlePrWebhookPayload: closed+merged on an unlinked PR auto-links and settles", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-webhook");
  const out = handlePrWebhookPayload(make.store,
    prPayload({ top: { action: "closed" }, pull_request: { merged: true, state: "closed" } }), {});
  assert.equal(out.ok, true);
  assert.equal(out.linked.claimId, "lane-webhook");
  assert.equal(out.linked.source, "branch");
  assert.equal(out.settled.length, 1);
  assert.equal(out.settled[0].outcome, "merged");
  const item = make.store.workClaims.get(make.roomId, "lane-webhook");
  assert.equal(item.state, "done");
  assert.equal(item.pullRequest.outcome, "merged");
});

test("handlePrWebhookPayload: opened only links, unknown ids and garbage never write", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-open");
  const before = claimEvents(make.store, make.roomId).length;
  const opened = handlePrWebhookPayload(make.store,
    prPayload({ pull_request: { head: { ref: "lane-open" } } }), {});
  assert.equal(opened.ok, true);
  assert.equal(opened.linked.claimId, "lane-open");
  assert.equal(opened.settled.length, 0);
  assert.equal(make.store.workClaims.get(make.roomId, "lane-open").state, "claimed");
  const unknown = handlePrWebhookPayload(make.store,
    prPayload({ pull_request: { html_url: URL_B, head: { ref: "no-such-claim" }, title: "x", body: "y" } }), {});
  assert.equal(unknown.ok, true);
  assert.equal(unknown.linked, null);
  const garbage = handlePrWebhookPayload(make.store, { action: "closed" }, {});
  assert.equal(garbage.ok, false);
  const nulls = handlePrWebhookPayload(make.store, null, {});
  assert.equal(nulls.ok, false);
  assert.equal(claimEvents(make.store, make.roomId).length, before + 1);
});

// --- 4. poll fallback ----------------------------------------------------

function pullsFetch(pulls, seen) {
  return async endpoint => {
    seen.push(endpoint);
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => pulls,
    };
  };
}

test("discoverUnlinkedPulls: open PRs link claims that carry no PR yet", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-poll");
  await liveClaim(make, "lane-quiet");
  const seen = [];
  const out = await discoverUnlinkedPulls(make.store, {
    fetchImpl: pullsFetch([{ html_url: URL_A, number: 7, head: { ref: "lane-poll" }, title: "lane-poll", body: "" }], seen),
    token: "tok", nowMs: 1_700_000_000_000,
  });
  assert.ok(seen.length >= 1);
  assert.match(seen[0], /\/repos\/Uuriko\/project-room\/pulls\?/);
  assert.equal(out.linked.length, 1);
  assert.equal(out.linked[0].claimId, "lane-poll");
  assert.equal(out.linked[0].source, "branch");
  const item = make.store.workClaims.get(make.roomId, "lane-poll");
  assert.equal(item.pullRequest.url, URL_A);
  assert.equal(make.store.workClaims.get(make.roomId, "lane-quiet").pullRequests.length, 0);
});

test("discoverUnlinkedPulls: fresh webhook delivery skips the repo; a held budget stops the poll", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-skip");
  // record a fresh delivery via the webhook core (unknown claim: no link, delivery still recorded)
  handlePrWebhookPayload(make.store,
    prPayload({ pull_request: { html_url: URL_B, head: { ref: "ghost" }, title: "ghost", body: "" } }), {});
  const seen = [];
  const skipped = await discoverUnlinkedPulls(make.store, {
    fetchImpl: pullsFetch([], seen), token: "tok", nowMs: 1_700_000_000_000,
  });
  assert.equal(seen.length, 0);
  assert.equal(skipped.linked.length, 0);
  writeClaimPullBudget(make.store, 1_700_000_000_000 + 60_000, 1_700_000_000_000);
  const held = await discoverUnlinkedPulls(make.store, {
    fetchImpl: pullsFetch([], seen), token: "tok", nowMs: 1_700_000_000_000,
  });
  assert.equal(held.rateLimited, true);
  assert.equal(seen.length, 0);
});

// --- 5. deploy linking ---------------------------------------------------

test("linkDeployToSettledClaims: stamped revision links back to the items it shipped", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-deploy");
  const rev = "a".repeat(40);
  const before = claimEvents(make.store, make.roomId).length;
  // settle via merge, then stamp the required revision and close it live
  handlePrWebhookPayload(make.store,
    prPayload({ top: { action: "closed" }, pull_request: { head: { ref: "lane-deploy" }, merged: true, state: "closed" } }), {});
  let item = make.store.workClaims.get(make.roomId, "lane-deploy");
  assert.equal(item.revision, null); // normal claims carry no required revision
  const out = linkDeployToSettledClaims(make.store, { revision: rev, nowMs: 1_700_000_000_000 });
  assert.equal(out.linked, 0);
  assert.equal(claimEvents(make.store, make.roomId).length, before + 2); // auto-link + settle events
});

test("linkDeployToSettledClaims: land-kind items with a matching revision get the deploy link", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-land", { create: { kind: "land" } });
  const rev = "b".repeat(40);
  // a land claim settled once its required revision is live: simulate the
  // merge recording the revision and the deploy closing it
  const item0 = make.store.workClaims.get(make.roomId, "lane-land");
  make.store.workClaims.set(make.roomId, { ...item0, state: "done", revision: rev });
  const before = claimEvents(make.store, make.roomId).length;
  const out = linkDeployToSettledClaims(make.store, { revision: rev, nowMs: 1_700_000_000_000 });
  assert.equal(out.linked, 1);
  const item = make.store.workClaims.get(make.roomId, "lane-land");
  assert.equal(item.deploy.revision, rev);
  assert.equal(item.history.at(-1).action, "deploy_linked");
  const events = claimEvents(make.store, make.roomId);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).data.action, "state_changed");
  assert.equal(events.at(-1).data.reason, undefined);
  // unstamped and mismatched revisions link nothing
  assert.equal(linkDeployToSettledClaims(make.store, { revision: "unstamped" }).linked, 0);
  assert.equal(linkDeployToSettledClaims(make.store, { revision: "c".repeat(40) }).linked, 0);
  assert.equal(linkDeployToSettledClaims(make.store, { revision: rev }).linked, 0); // already linked
});

// --- 6. the flag ---------------------------------------------------------

test("prWebhookEnabled: off by default, on only with an explicit value", () => {
  assert.equal(prWebhookEnabled({}), false);
  assert.equal(prWebhookEnabled({ [PR_WEBHOOK_FLAG]: "0" }), false);
  assert.equal(prWebhookEnabled({ [PR_WEBHOOK_FLAG]: "1" }), true);
  assert.equal(prWebhookEnabled({ [PR_WEBHOOK_FLAG]: "true" }), true);
  assert.equal(prWebhookEnabled(undefined), false);
});

function webhookCtx({ store, rawBody, headers = {}, env }) {
  const prev = { ...process.env };
  if (env) { for (const key of Object.keys(env)) process.env[key] = env[key]; }
  return {
    restore() {
      for (const key of Object.keys(process.env)) if (!(key in prev)) delete process.env[key];
      for (const key of Object.keys(prev)) process.env[key] = prev[key];
    },
    req: { method: "POST", headers: { "content-type": "application/json", ...headers } },
    res: {},
    url: new URL("https://room.example/api/github/pr-webhook"),
    store,
    remoteAddress: "203.0.113.9",
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    rate: () => {},
    readText: async () => rawBody,
  };
}

test("POST /api/github/pr-webhook: 404 when the flag is off, 503 when enabled without a secret", async t => {
  const make = makeRoom(t);
  const body = JSON.stringify(prPayload());
  const off = webhookCtx({ store: make.store, rawBody: body, env: {} });
  t.after(() => off.restore());
  await assert.rejects(postPrWebhook(off), error => error.status === 404);
  const noSecret = webhookCtx({ store: make.store, rawBody: body, env: { [PR_WEBHOOK_FLAG]: "1" } });
  t.after(() => noSecret.restore());
  await assert.rejects(postPrWebhook(noSecret), error => error.status === 503);
});

test("POST /api/github/pr-webhook: a signed delivery auto-links; a bad signature is refused", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-hook");
  const secret = "test-secret-value";
  const body = JSON.stringify(prPayload({ pull_request: { head: { ref: "lane-hook" } } }));
  const sign = raw => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const ctx = webhookCtx({ store: make.store, rawBody: body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) },
    env: { [PR_WEBHOOK_FLAG]: "1", [PR_WEBHOOK_SECRET_ENV]: secret } });
  t.after(() => ctx.restore());
  const out = await postPrWebhook(ctx);
  assert.equal(out.status, 200);
  assert.equal(out.value.ok, true);
  assert.equal(out.value.linked, "lane-hook");
  assert.equal(make.store.workClaims.get(make.roomId, "lane-hook").pullRequest.url, URL_A);
  const bad = webhookCtx({ store: make.store, rawBody: body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    env: { [PR_WEBHOOK_FLAG]: "1", [PR_WEBHOOK_SECRET_ENV]: secret } });
  t.after(() => bad.restore());
  await assert.rejects(postPrWebhook(bad), error => error.status === 401);
  // the response carries no PR body: claim id, PR number and state only
  assert.deepEqual(Object.keys(out.value).sort(), ["action", "event", "linked", "ok", "settled"]);
});
