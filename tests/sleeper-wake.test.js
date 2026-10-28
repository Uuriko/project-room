// Hostless agents with an agent.wake subscription stay silent until
// ROOM_OWNER_ASLEEP_WAKE covers their room. Then a mention, a room DM,
// and a peer DM each journal one ping, and a signal that was queued
// without a ping is journaled once by the dispatch catch-up.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { jobByName } from "../server/jobs.mjs";
import { catchUpMissedWakes } from "../server/sleeper-wake.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function startServer(t, f) {
  installFakeWebhookDns(f.store);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});

async function hostlessAgent(t, flag) {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  f.store.featureEnv = { ROOM_OWNER_ASLEEP_WAKE: flag };
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("sleeper");
  linkWithProof(f.store, f.keys.owner, "commons", identity, {
    memberId: "sleeper",
    displayName: "Sleeper", permissions: ["accept_work"],
  });
  f.store.dmConsents.request("commons", "owner", "sleeper", "fixture");
  f.store.dmConsents.decide("commons", "sleeper", "owner", "approve");
  const subscribed = await post(origin, "/api/agent-webhooks",
    { url: "https://sleeper.example.test/wake", events: ["agent.wake"] }, identity.secret);
  assert.equal(subscribed.status, 201);
  const sub = await subscribed.json();
  const mention = messageId => f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId, body: `@sleeper ${messageId}` },
  });
  const wakeCount = () => f.store.agentPlugin.webhookJournalFor({
    identityId: identity.identityId, subscriptionId: sub.subscriptionId,
  }).filter(row => row.eventType === "agent.wake").length;
  return { f, identity, sub, mention, wakeCount, advance: ms => { at += ms; } };
}

test("a hostless agent is not woken when the sleeper flag is off or names another room", async t => {
  const { f, identity, mention, wakeCount } = await hostlessAgent(t, "off");
  mention("off-mention");
  assert.equal(f.store.agentHeartbeats.pendingWakes(identity.identityId).length, 0);
  assert.equal(wakeCount(), 0);
  f.store.featureEnv = { ROOM_OWNER_ASLEEP_WAKE: "other-room" };
  mention("other-mention");
  assert.equal(f.store.agentHeartbeats.pendingWakes(identity.identityId).length, 0);
  assert.equal(wakeCount(), 0);
  assert.equal(catchUpMissedWakes(f.store).replayed, 0);
});

test("mention, room DM, and peer DM wake a hostless agent when the flag is on", async t => {
  const { f, identity, mention, wakeCount, advance } = await hostlessAgent(t, "on");
  mention("mention-1");
  const pending = f.store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "mention");
  assert.equal(pending[0].messageId, "mention-1");
  assert.equal(wakeCount(), 1, "one subscription ping and no host wake URL");

  advance(1);
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-1", body: "direct", toMemberId: "sleeper" } });
  const afterDm = f.store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(afterDm.length, 2);
  assert.equal(afterDm[1].kind, "dm");
  assert.equal(afterDm[1].messageId, "dm-1");
  assert.equal(wakeCount(), 2);

  const sender = f.store.identities.create("sender");
  linkWithProof(f.store, f.keys.owner, "commons", sender, {
    memberId: "sender",
    displayName: "Sender", permissions: ["accept_work"],
  });
  for (const memberId of ["sender", "sleeper"]) {
    setTier(f.store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  }
  const proposed = f.store.command(sender.secret, "commons", { id: randomUUID(), type: "bond.propose",
    data: { to: identity.identityId, scopes: ["peer.dm"] } });
  f.store.command(identity.secret, "commons", { id: randomUUID(), type: "bond.accept",
    data: { bondId: proposed.event.data.bondId, scopes: ["peer.dm"] } });
  advance(1);
  f.store.command(sender.secret, "commons", { id: randomUUID(), type: "dm.posted",
    data: { to: identity.identityId, messageId: "peer-1", body: "awake" } });
  const afterPeer = f.store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(afterPeer.at(-1).kind, "dm");
  assert.equal(afterPeer.at(-1).messageId, "peer-1");
  assert.equal(wakeCount(), 3);
});

test("dispatch catch-up journals a missed wake once, stays in the flagged room, and keeps the drain result", async t => {
  const { f, identity, sub } = await hostlessAgent(t, "on");
  const job = jobByName("webhook-dispatch");
  assert.equal(job.enabled({}, f.store), false, "an armed flag with nothing missed stays idle");

  f.store.featureEnv = { ROOM_OWNER_ASLEEP_WAKE: "commons" };
  f.store.agentHeartbeats.enqueueWake({
    agentId: identity.identityId, kind: "mention", roomId: "night-room", messageId: "missed-other",
  });
  assert.equal(catchUpMissedWakes(f.store).replayed, 0);
  assert.equal(job.enabled({}, f.store), false);

  const missed = f.store.agentHeartbeats.enqueueWake({
    agentId: identity.identityId, kind: "dm", roomId: "commons", messageId: "missed-here",
  }).signal;
  assert.equal(job.enabled({}, f.store), true);
  assert.ok(job.nextDueAt(f.store) <= f.store.now());
  const drained = { processed: 4, delivered: 4 };
  const result = await job.run(f.store, { room: { drainWebhookDeliveries: async () => drained } });
  assert.deepEqual(result, drained);
  const journal = f.store.agentPlugin.webhookJournalFor({
    identityId: identity.identityId, subscriptionId: sub.subscriptionId,
  });
  const wakes = journal.filter(row => row.eventType === "agent.wake");
  assert.equal(wakes.length, 1);
  assert.equal(catchUpMissedWakes(f.store).replayed, 0);

  f.store.db.prepare("UPDATE agent_webhook_deliveries SET state='dead_letter' WHERE event_id=?").run(missed.signalId);
  assert.equal(catchUpMissedWakes(f.store).replayed, 0);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE event_id=? AND event_type='agent.wake'"
  ).get(missed.signalId).n, 1);

  f.store.featureEnv = { ROOM_OWNER_ASLEEP_WAKE: "off" };
  f.store.agentHeartbeats.enqueueWake({
    agentId: identity.identityId, kind: "mention", roomId: "commons", messageId: "flag-off",
  });
  assert.equal(catchUpMissedWakes(f.store).replayed, 0);
  assert.equal(job.enabled({}, f.store), false);
});
