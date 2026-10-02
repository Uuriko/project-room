// BOARD-WAKE-1: assigning work wakes the agent.
//
// Authoring gate:
// 1. Observable contract: a pull-mode agent's next /api/agent-wakes/poll
//    returns the assigned claim with reason "assigned"; a webhook
//    subscription receives one signed agent.wake; a lapsed lease wakes the
//    former owner once; a paused or read-only agent gets no wake and still
//    gets the work_claim.updated attention item Updates reads.
// 2. Regression: reassign, create-with-assignee, or lease sweep commits the
//    board change and forgets the wake, double-wakes a lapse, or wakes
//    someone who is paused or read-only.
// 3. Existing review and CI wake tests enqueue under a member id and never
//    poll, never check a signature, and never advance a clock.
// 4. No test-only seam: poll, the webhook journal, the claim history, and
//    the room event are the production surfaces.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { verifyDeliverySignature } from "../server/webhook-dispatch.mjs";

const SIGNING_SECRET = "board-wake-signing-secret-012345";

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
  const enroll = name => {
    const identity = store.identities.create(name);
    const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
    store.identities.link(ownerKey, "commons", {
      identityId: identity.identityId, memberId, displayName: name,
      permissions: ["accept_work", "complete_work"]
    });
    return { ...identity, memberId };
  };
  const post = async (path, body, secret) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  const poll = async secret => {
    const response = await fetch(`${origin}/api/agent-wakes/poll?hostId=host-1&waitMs=0`, {
      headers: { authorization: `Bearer ${secret}` }
    });
    return { status: response.status, value: await response.json() };
  };
  const attention = async () => (await owner.changes(0, 100)).events
    .map(row => row.event)
    .filter(event => event.type === "work_claim.updated" && event.data?.attention === "assigned");
  return { store, origin, ownerKey, owner, enroll, post, poll, attention, advance: ms => { at += ms; } };
}

test("reassign to a pull-mode agent is the next wake, with reason assigned", async t => {
  const { owner, enroll, post, poll } = await fixture(t);
  const agent = enroll("Pull Agent");
  const beat = await post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, agent.secret);
  assert.equal(beat.status, 200);
  await owner.workClaimCreate({ id: "lane-a", title: "Lane A" });
  await owner.claimWorkItem("lane-a");
  const reassigned = await owner.reassignWorkItem("lane-a", { newOwner: agent.memberId, note: "yours" });
  assert.equal(reassigned.owner, agent.memberId);
  const woken = await poll(agent.secret);
  assert.equal(woken.status, 200);
  assert.equal(woken.value.pendingWakes.length, 1);
  assert.equal(woken.value.pendingWakes[0].reason, "assigned");
  assert.equal(woken.value.pendingWakes[0].workClaim, "lane-a");
  assert.match(woken.value.pendingWakes[0].messageId, /^work-claim:lane-a:assigned:/);
});

test("creating a claim with an assignee wakes that pull-mode agent", async t => {
  const { owner, enroll, post, poll } = await fixture(t);
  const agent = enroll("Create Agent");
  assert.equal((await post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, agent.secret)).status, 200);
  const created = await owner.workClaimCreate({ id: "lane-b", title: "Lane B", assignee: agent.memberId });
  assert.equal(created.state, "claimed");
  assert.equal(created.owner, agent.memberId);
  const woken = await poll(agent.secret);
  assert.equal(woken.value.pendingWakes.length, 1);
  assert.equal(woken.value.pendingWakes[0].reason, "assigned");
  assert.equal(woken.value.pendingWakes[0].workClaim, "lane-b");
});

test("a webhook-mode agent gets one signed delivery for the assignment", async t => {
  const { store, owner, enroll, post } = await fixture(t);
  const agent = enroll("Hook Agent");
  const subscribed = await post("/api/agent-webhooks", {
    url: "https://hooks.example.test/board-wake",
    events: ["agent.wake"],
    secret: SIGNING_SECRET
  }, agent.secret);
  assert.equal(subscribed.status, 201);
  await owner.workClaimCreate({ id: "lane-c", title: "Lane C" });
  await owner.claimWorkItem("lane-c");
  await owner.reassignWorkItem("lane-c", { newOwner: agent.memberId });
  const rows = store.db.prepare(
    "SELECT payload_json, signature, created_at, event_type FROM agent_webhook_deliveries WHERE agent_id=?"
  ).all(agent.identityId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, "agent.wake");
  assert.match(rows[0].signature, /^[0-9a-f]{64}$/);
  const envelope = JSON.parse(rows[0].payload_json);
  assert.equal(envelope.data.signal.reason, "assigned");
  assert.equal(envelope.data.signal.workClaim, "lane-c");
  assert.equal(verifyDeliverySignature(SIGNING_SECRET, rows[0].signature, {
    deliveryId: envelope.deliveryId,
    eventType: envelope.eventType,
    issuedAt: rows[0].created_at,
    data: envelope.data
  }), true);
});

test("lease expiry under a fake clock wakes the former owner once", async t => {
  const { store, origin, owner, enroll, post, poll, advance } = await fixture(t);
  const agent = enroll("Lease Agent");
  assert.equal((await post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, agent.secret)).status, 200);
  const key = store.issueAccessKey("commons", agent.memberId);
  const holder = new RoomAgentClient({ origin, roomId: "commons", token: key });
  await owner.workClaimCreate({ id: "lane-d", title: "Lane D" });
  await holder.claimWorkItem("lane-d", { leaseHours: 1 });
  advance(2 * 60 * 60 * 1000);
  const listed = await owner.workClaims();
  assert.deepEqual(listed.swept, ["lane-d"]);
  const first = await poll(agent.secret);
  assert.equal(first.value.pendingWakes.length, 1);
  assert.equal(first.value.pendingWakes[0].reason, "lease_expired");
  assert.equal(first.value.pendingWakes[0].workClaim, "lane-d");
  const again = await owner.workClaims();
  assert.deepEqual(again.swept, []);
  const second = await poll(agent.secret);
  assert.equal(second.value.pendingWakes.length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get(agent.identityId).n, 1);
  const item = await owner.workClaimGet("lane-d");
  assert.equal(item.state, "unclaimed");
  assert.equal(item.owner, null);
  assert.equal(item.history.at(-1).action, "lease_expired");
});

test("a paused agent gets no wake and still gets an Updates attention item", async t => {
  const { store, ownerKey, owner, enroll, post, poll, attention } = await fixture(t);
  const agent = enroll("Paused Agent");
  assert.equal((await post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, agent.secret)).status, 200);
  await owner.workClaimCreate({ id: "lane-e", title: "Lane E" });
  await owner.claimWorkItem("lane-e");
  store.wakeQueue.pause(ownerKey, "commons", { requestId: randomUUID(), reason: "away" }, null, { memberId: agent.memberId });
  await owner.reassignWorkItem("lane-e", { newOwner: agent.memberId });
  const woken = await poll(agent.secret);
  assert.equal(woken.value.pendingWakes.length, 0);
  const items = await attention();
  assert.equal(items.length, 1);
  assert.equal(items[0].data.attention, "assigned");
  assert.equal(items[0].data.attentionMemberId, agent.memberId);
  assert.equal(items[0].data.workClaim, "lane-e");
});

test("a read-only agent gets no assignment wake and still gets the attention item", async t => {
  const { store, owner, enroll, post, poll, attention } = await fixture(t);
  const agent = enroll("Readonly Agent");
  assert.equal((await post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, agent.secret)).status, 200);
  setTier(store.db, "commons", agent.memberId, "t1_readonly", { updatedBy: "owner", nowMs: store.now() });
  await owner.workClaimCreate({ id: "lane-f", title: "Lane F" });
  await owner.claimWorkItem("lane-f");
  await owner.reassignWorkItem("lane-f", { newOwner: agent.memberId });
  const woken = await poll(agent.secret);
  assert.equal(woken.value.pendingWakes.length, 0);
  const items = await attention();
  assert.equal(items.length, 1);
  assert.equal(items[0].data.attentionMemberId, agent.memberId);
});
