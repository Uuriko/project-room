import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomStore } from "../server/store.mjs";
import { dispatchGithubReview, observeWebhookPull, readGithubReviewWebhookBinding } from "../server/github-review-webhook.mjs";
import { buildReplyCommand } from "../client/reply-actions.mjs";

const head = "a".repeat(40), oldHead = "b".repeat(40), newHead = "c".repeat(40);
const repo = "Uuriko/project-room";
const delivery = (sha, number = 6319) => ({ event: "pull_request", action: "synchronize",
  payload: { repository: { full_name: repo }, pull_request: { number, head: { sha } } } });
const snapshot = (sha, conclusion = "success") => ({ repository: repo, number: 6319, head: sha,
  state: "open", draft: false, merged: false, observedAt: Date.now(), checks: [{ name: "safety-net",
    app: "github-actions", id: 22, head: sha, status: "completed", conclusion }] });
const checkDelivery = (sha, id, conclusion) => ({ event: "check_run", action: "completed",
  payload: { repository: { full_name: repo }, check_run: { id, app: { slug: "github-actions" },
    name: "safety-net", head_sha: sha, pull_requests: [{ number: 6319 }], conclusion } } });

test("exact webhook review uses one native request across redelivery, and stale heads append nothing", async t => {
  const directory = mkdtempSync(join(tmpdir(), "github-review-hook-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  const secret = store.issueAccessKey("commons", "owner");
  const reviewer = store.invites.redeem(store.invites.create(secret, "commons", { profile: "contribute" }).code, { displayName: "Muse" });
  store.command(secret, "commons", { id: "proposal", type: "work.proposed", data: {
    workItemId: "qa", title: "GitHub QA", accountableMemberId: reviewer.memberId, mode: "read", definitionOfDone: "Review exact source"
  } });
  const binding = readGithubReviewWebhookBinding({ version: 1, enabled: true, roomId: "commons", repository: repo,
    requiredChecks: [{ app: "github-actions", name: "safety-net" }], pulls: [6319],
    requesterId: "owner", reviewerId: reviewer.memberId, workItemId: "qa" });
  let calls = 0, current = snapshot(head, "skipped");
  const options = { credential: () => secret, observe: async () => { calls++; return { snapshot: current }; } };
  const start = store.headSequence("commons");
  assert.deepEqual(await dispatchGithubReview(store, null, delivery(head), options), []);
  assert.deepEqual(await dispatchGithubReview(store, binding, delivery(head, 1111), options), []);
  assert.deepEqual(await dispatchGithubReview(store, binding, delivery(oldHead), options), [{ number: 6319, status: "stale_head" }]);
  assert.deepEqual(await dispatchGithubReview(store, binding, delivery(head), options), [{ number: 6319, status: "required_check_failed" }]);
  assert.equal(store.headSequence("commons"), start);
  const irrelevantCheck = { event: "check_run", action: "completed", payload: { repository: { full_name: repo },
    check_run: { app: { slug: "github-actions" }, name: "unrelated", head_sha: head, pull_requests: [{ number: 6319 }] } } };
  assert.deepEqual(await dispatchGithubReview(store, binding, irrelevantCheck, options), []);
  current = snapshot(head);
  const first = await dispatchGithubReview(store, binding, delivery(head), options);
  assert.deepEqual(first, [{ number: 6319, status: "posted" }]);
  const saved = store.headSequence("commons");
  assert.deepEqual(await dispatchGithubReview(store, binding, delivery(head), options), [{ number: 6319, status: "replayed" }]);
  assert.equal(store.headSequence("commons"), saved);
  assert.equal(calls, 3, "durable redelivery lookup must skip GitHub");
  current = snapshot(newHead);
  const suite = { event: "check_suite", action: "completed", payload: { repository: { full_name: repo },
    check_suite: { head_sha: newHead, pull_requests: [{ number: 6319 }, { number: 6319 }] } } };
  const concurrent = await Promise.all([dispatchGithubReview(store, binding, suite, options), dispatchGithubReview(store, binding, suite, options)]);
  assert.deepEqual(concurrent.flat().map(x => x.status).sort(), ["posted", "replayed"]);
  const inbox = store.replyRequests.list(reviewer.identitySecret, "commons", { direction: "incoming", status: "open" });
  assert.equal(inbox.requests.length, 2);
  const body = store.snapshot(reviewer.identitySecret, "commons").state.messages.find(message => message.id === inbox.requests[0].id).body;
  assert.match(body, /Candidate revision: [ac]{40}/);

  const beforeFailure = store.headSequence("commons");
  const nextCheck = (id, conclusion) => {
    current = snapshot(newHead, conclusion);
    current.checks[0].id = id;
  };
  nextCheck(24, "success");
  assert.deepEqual(await dispatchGithubReview(store, binding, checkDelivery(newHead, 23, "failure"), options),
    [{ number: 6319, status: "replayed" }], "a delayed failed check cannot withdraw a review on a currently passing head");
  assert.equal(store.headSequence("commons"), beforeFailure);
  nextCheck(25, "failure");
  const failed = checkDelivery(newHead, 25, "failure");
  const withdrawals = await Promise.all([dispatchGithubReview(store, binding, failed, options),
    dispatchGithubReview(store, binding, failed, options)]);
  assert.deepEqual(withdrawals.flat().map(row => row.status).sort(), ["replayed", "withdrawn"]);
  assert.equal(store.headSequence("commons"), beforeFailure + 1);
  const cancelled = store.replyRequests.list(reviewer.identitySecret, "commons", { direction: "incoming", status: "cancelled" });
  assert.equal(cancelled.requests.length, 1);
  assert.ok(inbox.requests.some(request => request.id === cancelled.requests[0].id));
  const callsAfterWithdrawal = calls;
  assert.deepEqual(await dispatchGithubReview(store, binding, failed, options), [{ number: 6319, status: "replayed" }]);
  assert.equal(calls, callsAfterWithdrawal, "retry after a lost withdrawal response needs no GitHub read");
  assert.equal(store.headSequence("commons"), beforeFailure + 1);
  assert.equal(store.replyRequests.list(reviewer.identitySecret, "commons", { direction: "incoming", status: "open" }).requests.length, 1);

  nextCheck(24, "success");
  assert.deepEqual(await dispatchGithubReview(store, binding, checkDelivery(newHead, 24, "success"), options),
    [{ number: 6319, status: "replayed" }], "a stale passing observation cannot revive the withdrawn review");
  nextCheck(26, "success");
  const repaired = checkDelivery(newHead, 26, "success");
  const replacement = await Promise.all([dispatchGithubReview(store, binding, repaired, options),
    dispatchGithubReview(store, binding, repaired, options)]);
  assert.deepEqual(replacement.flat().map(row => row.status).sort(), ["posted", "replayed"]);
  assert.equal(store.headSequence("commons"), beforeFailure + 2);
  const activeAfterRepair = store.replyRequests.list(reviewer.identitySecret, "commons", { direction: "incoming", status: "open" }).requests;
  assert.equal(activeAfterRepair.length, 2, "one open review for each of the two heads");
  const fresh = activeAfterRepair.find(request => !inbox.requests.some(prior => prior.id === request.id));
  assert.ok(fresh);
  const message = store.snapshot(reviewer.identitySecret, "commons").state.messages.find(row => row.id === fresh.id);
  assert.equal(message.replyToId, cancelled.requests[0].id, "replacement retains the original Work Thread context");
  assert.match(message.body, /attempt 26/);
  const callsAfterRepair = calls;
  assert.deepEqual(await dispatchGithubReview(store, binding, repaired, options), [{ number: 6319, status: "replayed" }]);
  assert.equal(calls, callsAfterRepair, "lost replacement response is recovered without GitHub reads");
  assert.equal(store.headSequence("commons"), beforeFailure + 2);

  store.command(secret, "commons", buildReplyCommand({roomId:"commons",memberId:"owner"}, "room_cancel_request", {
    requestId:"human-chose-to-cancel", requestMessageId:fresh.id, expectedRequestRevision:fresh.revision,
    reason:"Hold this candidate for a different reason.",
  }));
  nextCheck(27, "success");
  assert.deepEqual(await dispatchGithubReview(store, binding, checkDelivery(newHead, 27, "success"), options),
    [{ number: 6319, status: "replayed" }], "GitHub cannot reopen a human cancellation");
  assert.equal(calls, callsAfterRepair);
  assert.equal(store.headSequence("commons"), beforeFailure + 3);
});

test("authoritative GitHub reads pause before checking stale candidates and recheck the exact head before posting", async () => {
  const recipe = { repository: repo.toLowerCase() };
  const row = sha => ({ base: { repo: { full_name: repo } }, number: 6319, head: { sha }, state: "open", draft: false, merged: false });
  const queue = [row(head), row(head), { total_count: 0, check_runs: [] }, row(newHead)];
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return Response.json(queue.shift()); };
  assert.deepEqual(await observeWebhookPull(recipe, { number: 6319, head: oldHead }, { fetchImpl }), { reason: "stale_head" });
  assert.equal(urls.length, 1);
  assert.deepEqual(await observeWebhookPull(recipe, { number: 6319, head }, { fetchImpl }), { reason: "pull_changed" });
  assert.equal(urls.length, 4);
});

test("webhook review refuses truncated or shifting check evidence", async () => {
  const recipe = { repository: repo.toLowerCase() };
  const pull = { base: { repo: { full_name: repo } }, number: 6319, head: { sha: head }, state: "open", draft: false, merged: false };
  const passed = { id: 1, head_sha: head, name: "safety-net", app: { slug: "github-actions" }, status: "completed", conclusion: "success" };
  const newer = { ...passed, id: 2, conclusion: "failure" };
  const fetchPages = pages => {
    const queue = pages.map(({ count, rows, more }) => Response.json({ total_count: count, check_runs: rows }, {
      headers: more ? { link: '<https://api.github.com/check-runs?page=2>; rel="next"' } : {},
    }));
    return async url => url.includes("check-runs?") ? queue.shift() : Response.json(pull);
  };
  for (const pages of [
    [{ count: 2, rows: [passed] }],
    [{ count: 2, rows: [passed], more: true }, { count: 2, rows: [passed] }],
    [{ count: 2, rows: [passed], more: true }, { count: 3, rows: [newer] }],
    [{ count: 1, rows: [{ ...passed, head_sha: oldHead }] }],
  ]) {
    assert.deepEqual(await observeWebhookPull(recipe, { number: 6319, head }, { fetchImpl: fetchPages(pages) }), { reason: "incomplete_checks" });
  }
  const complete = await observeWebhookPull(recipe, { number: 6319, head }, { fetchImpl: fetchPages([
    { count: 2, rows: [passed], more: true }, { count: 2, rows: [newer] },
  ]) });
  assert.deepEqual(complete.snapshot.checks.map(check => check.conclusion), ["success", "failure"]);
});
