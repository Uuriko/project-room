// When a Board prerequisite reaches done, each now-startable dependent's
// owner gets one ready_work claim wake. The message id is stable, and
// enqueueWake INSERT OR IGNOREs a redelivery of the same id.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { claimReadyWorkBasis, readyWorkMessageId, wakeReadyDependents } from "../server/work-claim-events.mjs";
import { commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import { appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  let at = Date.now();
  store.now = () => at;
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const enroll = async name => {
    const identity = store.identities.create(name);
    const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
    linkWithProof(store, ownerKey, "commons", identity, {
      memberId, displayName: name, permissions: ["accept_work", "complete_work"]
    });
    const beat = await fetch(`${origin}/api/agent-heartbeats`, {
      method: "POST",
      headers: { authorization: `Bearer ${identity.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", mode: "pull-only" })
    });
    assert.equal(beat.status, 200, await beat.text());
    return { ...identity, memberId };
  };
  const poll = async secret => {
    const response = await fetch(`${origin}/api/agent-wakes/poll?hostId=host-1&waitMs=0`, {
      headers: { authorization: `Bearer ${secret}` }
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const ack = async (secret, signalIds) => {
    const response = await fetch(`${origin}/api/agent-heartbeats/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ signalIds })
    });
    assert.equal(response.status, 200, await response.text());
  };
  return { store, origin, owner, enroll, poll, ack };
}

async function finish(owner, id) {
  const started = await owner.updateWorkItem(id, { state: "in_progress" });
  assert.equal(started.state, "in_progress", JSON.stringify(started));
  const done = await owner.updateWorkItem(id, { state: "done", note: "prerequisite complete" });
  assert.equal(done.state, "done", JSON.stringify(done));
  return done;
}

test("finishing a prerequisite wakes the startable dependent's owner with a stable ready_work id", async t => {
  const { store, owner, enroll, poll, ack } = await fixture(t);
  const agent = await enroll("Ready Agent");
  await owner.workClaimCreate({ id: "prereq", title: "Prerequisite", reviewPolicy: "self_attested" });
  await owner.claimWorkItem("prereq");
  const dependent = await owner.workClaimCreate({
    id: "follow-on", title: "Follow-on work", reviewPolicy: "self_attested",
    dependsOn: ["prereq"], assignee: agent.memberId
  });
  assert.equal(dependent.owner, agent.memberId);
  const assigned = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "assigned");
  assert.ok(assigned.length >= 1);
  await ack(agent.secret, assigned.map(wake => wake.signalId));

  await finish(owner, "prereq");
  const first = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work");
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].workClaim, "follow-on");
  const expected = readyWorkMessageId(store.workClaims.get("commons", "follow-on"),
    claimReadyWorkBasis([store.workClaims.get("commons", "prereq")]));
  assert.equal(first[0].messageId, expected);
  assert.match(first[0].messageId, /^work-claim:follow-on:ready_work:none:[0-9a-f]{64}$/);

  // A second poll without ack redelivers the same signal. Calling the hook
  // again INSERT OR IGNOREs the same message id, so no second wake is born.
  const redelivered = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work");
  assert.equal(redelivered.length, 1);
  assert.equal(redelivered[0].signalId, first[0].signalId);

  const repeated = wakeReadyDependents(store, "commons", store.workClaims.get("commons", "prereq"), { actorId: "owner" });
  assert.equal(repeated.length, 0);
  const again = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work");
  assert.equal(again.length, 1);
  assert.equal(again[0].signalId, first[0].signalId);
  assert.equal(again[0].messageId, first[0].messageId);
});

test("a later actionable dependent still wakes when an older one is still blocked", async t => {
  const { owner, enroll, poll, ack } = await fixture(t);
  const agent = await enroll("Queued Agent");
  await owner.workClaimCreate({ id: "done-dep", title: "First prerequisite", reviewPolicy: "self_attested" });
  await owner.claimWorkItem("done-dep");
  await owner.workClaimCreate({ id: "open-dep", title: "Still open prerequisite", reviewPolicy: "self_attested" });
  const blocked = await owner.workClaimCreate({
    id: "blocked-follow", title: "Needs both", reviewPolicy: "self_attested",
    dependsOn: ["done-dep", "open-dep"], assignee: agent.memberId
  });
  const ready = await owner.workClaimCreate({
    id: "ready-follow", title: "Needs only the first", reviewPolicy: "self_attested",
    dependsOn: ["done-dep"], assignee: agent.memberId
  });
  assert.equal(blocked.owner, agent.memberId);
  assert.equal(ready.owner, agent.memberId);
  const assigned = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "assigned");
  await ack(agent.secret, assigned.map(wake => wake.signalId));

  await finish(owner, "done-dep");
  const wakes = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work");
  assert.equal(wakes.length, 1, JSON.stringify(wakes));
  assert.equal(wakes[0].workClaim, "ready-follow");
});

test("a linked-PR settlement that finishes a prerequisite wakes the dependent's owner exactly once", async t => {
  const { store, owner, enroll, poll, ack } = await fixture(t);
  const agent = await enroll("Settled Agent");
  await owner.workClaimCreate({ id: "pr-prereq", title: "Prerequisite landed by PR", reviewPolicy: "self_attested" });
  await owner.claimWorkItem("pr-prereq");
  const dependent = await owner.workClaimCreate({
    id: "pr-follow", title: "Follow-on after merge", reviewPolicy: "self_attested",
    dependsOn: ["pr-prereq"], assignee: agent.memberId
  });
  assert.equal(dependent.owner, agent.memberId);
  const assigned = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "assigned");
  await ack(agent.secret, assigned.map(wake => wake.signalId));

  const url = "https://github.com/Uuriko/project-room/pull/6384";
  const claimed = store.workClaims.get("commons", "pr-prereq");
  const linked = appendWorkPullRequest(claimed, claimed.owner, {
    pullRequest: url, expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimHistoryLength(claimed), now: store.now()
  });
  store.workClaims.set("commons", linked);
  assert.equal((await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work").length, 0,
    "no ready_work before the prerequisite settles");

  // The poller/webhook settlement path, not the HTTP persistClaim hook.
  const result = { claimId: "pr-prereq", url, kind: "merged" };
  const listed = [];
  const list = store.workClaims.list.bind(store.workClaims);
  store.workClaims.list = (roomId, ...rest) => { listed.push(roomId); return list(roomId, ...rest); };
  assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", linked, result, store.now()), true);
  store.workClaims.list = list;
  assert.deepEqual(listed, [], "settlement finds dependents through the index, never by listing the room");
  assert.equal(store.workClaims.get("commons", "pr-prereq").state, "done");
  const wakes = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work");
  assert.equal(wakes.length, 1, JSON.stringify(wakes));
  assert.equal(wakes[0].workClaim, "pr-follow");
  assert.equal(wakes[0].messageId, readyWorkMessageId(store.workClaims.get("commons", "pr-follow"),
    claimReadyWorkBasis([store.workClaims.get("commons", "pr-prereq")])));

  // A stale-item retry of the same lookup settles nothing and wakes nothing new.
  assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", linked, result, store.now() + 1000), false);
  const again = (await poll(agent.secret)).pendingWakes.filter(wake => wake.reason === "ready_work");
  assert.equal(again.length, 1);
  assert.equal(again[0].signalId, wakes[0].signalId);
});
