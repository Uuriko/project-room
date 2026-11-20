import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomStore } from "../server/store.mjs";
import { dispatchGithubReview, observeWebhookPull, readGithubReviewWebhookBinding } from "../server/github-review-webhook.mjs";

const head = "a".repeat(40), oldHead = "b".repeat(40), newHead = "c".repeat(40);
const repo = "Uuriko/project-room";
const delivery = (sha, number = 6319) => ({ event: "pull_request", action: "synchronize",
  payload: { repository: { full_name: repo }, pull_request: { number, head: { sha } } } });
const snapshot = (sha, conclusion = "success") => ({ repository: repo, number: 6319, head: sha,
  state: "open", draft: false, merged: false, observedAt: Date.now(), checks: [{ name: "safety-net",
    app: "github-actions", id: 22, head: sha, status: "completed", conclusion }] });

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
});

test("authoritative GitHub reads pause before checking stale candidates and recheck the exact head before posting", async () => {
  const recipe = { repository: repo.toLowerCase() };
  const row = sha => ({ base: { repo: { full_name: repo } }, number: 6319, head: { sha }, state: "open", draft: false, merged: false });
  const queue = [row(head), row(head), { check_runs: [] }, row(newHead)];
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return Response.json(queue.shift()); };
  assert.deepEqual(await observeWebhookPull(recipe, { number: 6319, head: oldHead }, { fetchImpl }), { reason: "stale_head" });
  assert.equal(urls.length, 1);
  assert.deepEqual(await observeWebhookPull(recipe, { number: 6319, head }, { fetchImpl }), { reason: "pull_changed" });
  assert.equal(urls.length, 4);
});
