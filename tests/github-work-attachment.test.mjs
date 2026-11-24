import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomStore } from "../server/store.mjs";
import { attachGithubWork } from "../server/github-work-attachment.mjs";
import { drainAttachedGithubDeliveries, readGithubReviewWebhookBinding, saveAttachedGithubDelivery } from "../server/github-review-webhook.mjs";

const head = "a".repeat(40), replacement = "b".repeat(40), number = 6568, repository = "uuriko/project-room";
const roomId = "commons";
const input = { workItemId: "ship-work", operationId: "attach-once", pullRequest: `https://github.com/${repository}/pull/${number}`,
  expectedHead: head, expectedRevision: 2 };
const event = (sha, suffix, action = "synchronize") => ({ event: "pull_request", delivery: "delivery-" + suffix, action,
  payload: { repository: { full_name: repository }, pull_request: { number, head: { sha } } } });

async function fixture(t, distinctProducer = false) {
  const directory = mkdtempSync(join(tmpdir(), "room-attached-pr-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom(roomId));
  const owner = store.issueAccessKey(roomId, "owner");
  const reviewer = store.invites.redeem(store.invites.create(owner, roomId, { profile: "contribute" }).code, { displayName: "Reviewer" });
  const producer = distinctProducer
    ? store.invites.redeem(store.invites.create(owner, roomId, { profile: "contribute" }).code, { displayName: "Producer" })
    : { memberId: "owner", identitySecret: owner };
  const cmd = (id, type, data) => store.command(type === "work.proposed" ? owner : producer.identitySecret, roomId, { id, type, data: { workItemId: input.workItemId, ...data } });
  cmd("propose", "work.proposed", { title: "Real release", definitionOfDone: "Check candidate", accountableMemberId: producer.memberId, mode: "read" });
  cmd("accept", "work.accepted", { expectedRevision: 0 });
  cmd("start", "work.started", { expectedRevision: 1 });
  const binding = readGithubReviewWebhookBinding({ enabled: true, version: 1, roomId, repository, pulls: [],
    requesterId: "owner", reviewerId: reviewer.memberId, workItemId: "legacy-work",
    requiredChecks: [{ app: "github-actions", name: "safety-net" }] });
  const snapshot = sha => ({ repository, number, head: sha, state: "open", draft: false, merged: false, observedAt: Date.now(), checks: [
    { id: 1, app: "github-actions", name: "safety-net", head: sha, status: "completed", conclusion: "success" }
  ] });
  return { get store() { return store; }, restart() { store.close(); store = new RoomStore(filename); }, owner, reviewer, producer, binding, snapshot,
    attach(overrides = {}) { return attachGithubWork(store, { token: producer.identitySecret, roomId, input, recipe: binding.recipe,
      observe: async () => ({ snapshot: snapshot(head) }), ...overrides }); } };
}

test("an exact attachment uses one durable receipt on a lost response and isolates the producer", async t => {
  const f = await fixture(t);
  await assert.rejects(f.attach({ token: f.reviewer.identitySecret }), { code: "pr_attachment_forbidden" });
  await assert.rejects(f.attach({ observe: async () => ({ reason: "stale_head" }) }), { code: "stale_head" });
  const first = await f.attach();
  assert.equal(first.replayed, false);
  f.restart();
  const retry = await f.attach({ observe: () => assert.fail("a saved receipt does not fetch GitHub again") });
  assert.deepEqual(retry, { ...first, replayed: true });
  assert.equal(f.store.workContext(f.owner, roomId, input.workItemId).pullRequest.observedHead, head);
  await assert.rejects(f.attach({ input: { ...input, expectedHead: replacement } }), { code: "idempotency_conflict" });
});

test("registered PRs survive a process restart and retire a stale review once", async t => {
  const f = await fixture(t);
  await f.attach();
  let current = head;
  const options = { credential: () => f.owner, observe: async (_recipe, candidate) =>
    candidate.head === current ? { snapshot: f.snapshot(current) } : { reason: "stale_head" } };
  assert.deepEqual(saveAttachedGithubDelivery(f.store, f.binding, event(head, "first")), [number]);
  assert.deepEqual(saveAttachedGithubDelivery(f.store, f.binding, event(head, "first")), [number]);
  f.restart();
  assert.deepEqual(await drainAttachedGithubDeliveries(f.store, f.binding, options), [{ status: "observed" }]);
  const list = () => f.store.replyRequests.list(f.reviewer.identitySecret, roomId, { direction: "incoming", status: "open" }).requests;
  const [original] = list();
  assert.equal(list().length, 1);
  current = replacement;
  saveAttachedGithubDelivery(f.store, f.binding, event(replacement, "replacement"));
  saveAttachedGithubDelivery(f.store, f.binding, event(head, "late"));
  const drained = await drainAttachedGithubDeliveries(f.store, f.binding, options);
  assert.deepEqual(drained, [{ status: "observed" }, { status: "observed" }]);
  const [next] = list();
  assert.equal(list().length, 1);
  assert.notEqual(next.id, original.id);
  assert.equal(next.workItemId, input.workItemId);
  assert.equal(f.store.workContext(f.owner, roomId, input.workItemId).pullRequest.observedHead, replacement);
});

test("a failing candidate yields one diagnosis and passing checks restore exact review", async t => {
  const f = await fixture(t);
  await f.attach();
  let check = { id: 1, conclusion: "success" };
  const options = { credential: () => f.owner, observe: async () => {
    const snapshot = f.snapshot(head);
    Object.assign(snapshot.checks[0], check);
    return { snapshot };
  } };
  const drain = async suffix => {
    saveAttachedGithubDelivery(f.store, f.binding, event(head, suffix));
    assert.deepEqual(await drainAttachedGithubDeliveries(f.store, f.binding, options), [{ status: "observed" }]);
  };
  const open = () => f.store.replyRequests.list(f.reviewer.identitySecret, roomId, { direction: "incoming", status: "open" }).requests;
  await drain("passing");
  const [review] = open();
  check = { id: 2, conclusion: "failure" };
  await drain("failure");
  const [diagnosis] = open();
  assert.notEqual(diagnosis.id, review.id);
  await drain("failure-redelivered");
  assert.deepEqual(open().map(request => request.id), [diagnosis.id]);
  check = { id: 3, conclusion: "success" };
  await drain("recovered");
  assert.equal(open().length, 1);
  assert.notEqual(open()[0].id, diagnosis.id);
  assert.notEqual(open()[0].id, review.id);
  assert.equal(f.store.workContext(f.owner, roomId, input.workItemId).pullRequest.next.checks[0].id, 3);
});

test("delivery admitted during an in-flight observation drains without a timer", async t => {
  const f = await fixture(t);
  await f.attach();
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const options = { credential: () => f.owner, observe: async (_recipe, { head: sha }) => {
    if (sha === head) { entered.resolve(); await gate.promise; }
    return { snapshot: f.snapshot(sha) };
  } };
  saveAttachedGithubDelivery(f.store, f.binding, event(head, "first"));
  const running = drainAttachedGithubDeliveries(f.store, f.binding, options);
  await entered.promise;
  saveAttachedGithubDelivery(f.store, f.binding, event(replacement, "arrived-during-drain"));
  const second = drainAttachedGithubDeliveries(f.store, f.binding, options);
  gate.resolve();
  assert.deepEqual(await running, [{ status: "observed" }, { status: "observed" }]);
  assert.equal(await second, await running);
  assert.equal(f.store.workContext(f.owner, roomId, input.workItemId).pullRequest.observedHead, replacement);
});

test("trusted GitHub corrections wake the producer once and suppress obsolete review", async t => {
  const f = await fixture(t, true);
  await f.attach();
  f.binding.correctionReviewerIds = [1234];
  let correctionIds = [];
  const options = { credential: () => f.owner, observe: async () => ({ snapshot: { ...f.snapshot(head), correctionIds } }) };
  const open = person => f.store.replyRequests.list(person.identitySecret, roomId, { direction: "incoming", status: "open" }).requests;
  const signal = async (suffix, action) => {
    saveAttachedGithubDelivery(f.store, f.binding, { ...event(head, suffix), event: "pull_request_review", action });
    assert.deepEqual(await drainAttachedGithubDeliveries(f.store, f.binding, options), [{ status: "observed" }]);
  };
  await signal("ordinary-review", "submitted");
  assert.equal(open(f.reviewer).length, 1);
  correctionIds = [246];
  await signal("trusted-correction", "submitted");
  const [correction] = open(f.producer);
  assert.ok(correction);
  assert.equal(open(f.reviewer).length, 0);
  await signal("replay-correction", "submitted");
  assert.deepEqual(open(f.producer).map(request => request.id), [correction.id]);
  correctionIds = [];
  await signal("trusted-correction-dismissed", "dismissed");
  assert.equal(open(f.producer).length, 0);
  assert.equal(open(f.reviewer).length, 1);
});
