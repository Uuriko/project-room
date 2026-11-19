import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { evaluateGithubReview, readGithubReviewRecipe } from "../client/github-review-recipe.mjs";
import { githubEventAffectsPull, observeGithubPull } from "../scripts/github-review-recipe.mjs";
import { holdMuseHandoff, museHandoffPolicy } from "../scripts/muse-stream-handoff.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";

const firstHead = "a".repeat(40), secondHead = "b".repeat(40);
const recipe = readGithubReviewRecipe({ enabled: true, version: 1, roomId: "commons", repository: "org/repo",
  requiredChecks: [{ app: "github-actions", name: "safety-net" }] });
const check = (id, head = firstHead, extra = {}) => ({ id, head, app: "github-actions", name: "safety-net",
  status: "completed", conclusion: "success", ...extra });
const snapshot = (observedAt, head, checks, extra = {}) => ({ repository: "Org/Repo", number: 41, state: "open",
  merged: false, draft: false, observedAt, head, checks, ...extra });

test("head changes withdraw exact offers and replay cannot revive the old candidate", () => {
  const first = evaluateGithubReview(recipe, snapshot(1, firstHead, [check(1)]));
  assert.equal(first.action, "review_ready");
  const repeated = evaluateGithubReview(recipe, snapshot(2, firstHead, [check(1)]), first.checkpoint);
  assert.equal(repeated.action, "unchanged");
  assert.equal(repeated.offerId, first.offerId);
  const changed = evaluateGithubReview(recipe, snapshot(3, secondHead, [check(1)]), repeated.checkpoint);
  assert.equal(changed.checks[0].status, "missing");
  assert.equal(changed.withdrawOfferId, first.offerId);
  assert.equal(changed.action, "hold");
  const stale = evaluateGithubReview(recipe, snapshot(2, firstHead, [check(1)]), changed.checkpoint);
  assert.equal(stale.reason, "observation_already_seen");
  assert.equal(stale.checkpoint.head, secondHead);
  const ready = evaluateGithubReview(recipe, snapshot(4, secondHead, [check(2, secondHead)]), changed.checkpoint);
  assert.equal(ready.action, "review_ready");
  assert.notEqual(ready.offerId, first.offerId);
});

test("same-head reruns supersede old check attempts and do not accept skipped or wrong-app checks", () => {
  const first = evaluateGithubReview(recipe, snapshot(1, firstHead, [check(1)]));
  const pending = evaluateGithubReview(recipe, snapshot(2, firstHead, [check(1), check(2, firstHead, { status: "queued", conclusion: null })]), first.checkpoint);
  assert.equal(pending.withdrawOfferId, first.offerId);
  assert.equal(pending.reason, "required_check_pending");
  assert.equal(evaluateGithubReview(recipe, snapshot(3, firstHead, [check(1)]), pending.checkpoint).reason, "older_check_attempt");
  const skipped = evaluateGithubReview(recipe, snapshot(4, firstHead, [check(2, firstHead, { conclusion: "skipped" }),
    check(10, firstHead, { app: "unrelated-app" })]), pending.checkpoint);
  assert.equal(skipped.reason, "required_check_failed");
  const restored = evaluateGithubReview(recipe, snapshot(5, firstHead, [check(3)]), skipped.checkpoint);
  assert.equal(restored.reason, "checks_rerun");
  assert.notEqual(restored.offerId, first.offerId);
  const closed = evaluateGithubReview(recipe, snapshot(6, firstHead, [], { state: "closed", merged: true }), restored.checkpoint);
  assert.equal(closed.action, "hold");
  assert.equal(closed.reason, "merged");
  assert.equal(closed.withdrawOfferId, restored.offerId);
});

test("a draft stays held and a checkpoint never crosses room, policy or PR", () => {
  const first = evaluateGithubReview(recipe, snapshot(1, firstHead, [check(1)], { draft: true }));
  assert.equal(first.reason, "draft");
  const other = readGithubReviewRecipe({ ...recipe, enabled: true, roomId: "another" });
  assert.throws(() => evaluateGithubReview(other, snapshot(2, firstHead, [check(1)]), first.checkpoint), /different room/);
  assert.throws(() => evaluateGithubReview(recipe, snapshot(2, firstHead, [check(1)], { number: 42 }), first.checkpoint), /different room/);
  assert.equal(evaluateGithubReview(recipe, snapshot(2, firstHead, [], { repository: "other/repo" })).action, "ignored");
});

test("the GitHub reader refuses a head that moves while it gathers checks", () => {
  const head = snapshot(1, firstHead, []);
  const reads = [head, [{ check_runs: [] }], { ...head, head: secondHead }];
  assert.throws(() => observeGithubPull("org/repo", 41, () => reads.shift()), /changed during observation/);
});

test("only selected GitHub deliveries request a refresh", () => {
  const repository = { full_name: "Org/Repo" };
  const change = { repository, check_suite: { pull_requests: [{ number: 41 }, { number: 42 }] } };
  assert.equal(githubEventAffectsPull(recipe, 41, "check_suite", change), true);
  assert.equal(githubEventAffectsPull(recipe, 99, "check_suite", change), false);
  assert.equal(githubEventAffectsPull(recipe, 41, "schedule", change), false);
  assert.equal(githubEventAffectsPull(recipe, 41, "pull_request", { ...change, pull_request: { number: 41 } }), true);
  assert.equal(githubEventAffectsPull(recipe, 41, "check_suite", { ...change, repository: { full_name: "other/repo" } }), false);
});

test("fresh Muse receiver joins, wakes and answers over HTTP without GitHub setup", async t => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-muse-recipe-"));
  const roomId = "fresh-muse";
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  const server = createRoomServer({ store });
  const stop = new AbortController();
  t.after(async () => {
    stop.abort();
    server.closeStreams();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  assert.deepEqual(evaluateGithubReview(readGithubReviewRecipe(undefined), null), { action: "disabled" });
  const ownerKey = store.issueAccessKey(roomId, "owner");
  const invitation = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const joined = store.invites.redeem(invitation.code, { displayName: "Muse fixture receiver" });
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId, memberId: joined.memberId, token: joined.identitySecret };
  const client = new RoomAgentClient(connection);
  assert.equal((await client.checkConnection()).memberId, joined.memberId);
  const after = store.headSequence(roomId);
  const policy = museHandoffPolicy({ version: 1, origin: connection.origin, roomId, memberId: joined.memberId,
    requesters: ["owner"], workItems: [], requests: [], allowStandaloneRequests: true, bootstrapAfter: after, windowSeconds: 30 }, connection);
  let checkpoint = { after, inFlight: null };
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(6000)]);
  const { promise: waiting, resolve: afterArmed } = Promise.withResolvers();
  const receive = holdMuseHandoff({ client, policy, checkpoint, signal, resumeStream: true,
    setWaiting(value) { if (value) afterArmed(); }, save(value) { checkpoint = value; } });
  await waiting;
  const { event } = store.command(ownerKey, roomId, { id: "first-ask", type: "message.posted", data: {
    messageId: "first-ask", requestKind: "reply", toMemberId: joined.memberId,
    body: "Suggest one sentence stating what the research brief should deliver."
  } });
  const notice = await receive;
  assert.equal(notice.openingEventId, event.id);
  assert.equal(notice.source, "stream_pointer");
  const context = await client.replyContext(notice.requestMessageId, { view: "compact" });
  const input = { requestId: "first-answer", responseToRequestId: context.request.id, ...context.current.answerBasis,
    responseOutcome: "answered", toMemberId: "owner", workItemId: context.request.workItemId, body: "Deliver three cited options and a recommendation." };
  const answer = await client.replyAction("room_respond_to_request", input);
  const replay = await client.replyAction("room_respond_to_request", input);
  assert.equal(replay.eventId, answer.eventId);
  assert.equal(replay.duplicate, true);
  const settled = await client.replyContext(notice.requestMessageId, { view: "compact" });
  assert.equal(settled.request.status, "answered");
  assert.equal(settled.request.terminalActorId, joined.memberId);
});
