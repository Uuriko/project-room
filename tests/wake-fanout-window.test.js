// A room post used to write a wake signal, an activity row, and a webhook
// delivery for every registered agent, including ones that have not polled
// in 24h. Muse-room's wake census is about 4 listening and 59 quiet, so
// that was ~15x the rows a broadcast needed. Humans are not wake targets.
// A subscriber with no host and no poll stamp is push-only and still
// receives the event.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { WAKEABLE_WINDOW_MS } from "../server/agent-heartbeats.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-wake-window-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  installFakeWebhookDns(store);
  const owner = store.issueAccessKey("commons", "owner");
  const post = (body, messageId = randomUUID()) => store.command(owner, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body },
  });
  const link = (name, memberId) => {
    const identity = store.identities.create(name);
    store.identities.link(owner, "commons", {
      identityId: identity.identityId, memberId, displayName: name, permissions: [],
    });
    return identity;
  };
  const signals = agentId => store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get(agentId).n;
  const activity = memberId => store.db.prepare(
    "SELECT COUNT(*) AS n FROM activity_events WHERE room_id='commons' AND user_id=?").get(memberId).n;
  const deliveries = agentId => store.db.prepare(
    `SELECT COUNT(*) AS n FROM agent_webhook_deliveries d
     JOIN agent_webhook_subs s ON s.subscription_id=d.subscription_id
     WHERE s.agent_id=?`).get(agentId).n;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, post, link, signals, activity, deliveries };
}

function subscribe(store, identityId, host) {
  store.agentPlugin.subscribeWebhook({
    identityId, url: `https://${host}.example.test/hook`, events: ["message.posted"],
  });
}

test("a post skips wake, activity, and delivery rows for agents quiet for 24h", t => {
  const f = setup(t);
  f.store.command(f.owner, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] },
  });
  const fresh = f.link("Fresh", "fresh");
  const stale = f.link("Stale", "stale");
  const push = f.link("Push", "push");
  f.store.agentHeartbeats.heartbeat({ agentId: fresh.identityId, hostId: "fresh-host", mode: "pull-only" });
  f.store.agentHeartbeats.heartbeat({ agentId: stale.identityId, hostId: "stale-host", mode: "pull-only" });
  f.store.db.prepare("UPDATE agent_wake_polls SET last_polled_at=? WHERE agent_id=?")
    .run(f.store.now() - WAKEABLE_WINDOW_MS - 1, stale.identityId);
  subscribe(f.store, fresh.identityId, "fresh");
  subscribe(f.store, stale.identityId, "stale");
  subscribe(f.store, push.identityId, "push");

  f.post("hey @Fresh @Stale @Push and @Maya");
  assert.equal(f.signals(fresh.identityId), 1);
  assert.equal(f.signals(stale.identityId), 0);
  assert.equal(f.signals(push.identityId), 0);
  assert.equal(f.activity("fresh"), 1);
  assert.equal(f.activity("stale"), 0);
  assert.equal(f.activity("push"), 0);
  assert.equal(f.activity("maya"), 1);
  assert.equal(f.deliveries(fresh.identityId), 1);
  assert.equal(f.deliveries(stale.identityId), 0);
  assert.equal(f.deliveries(push.identityId), 1);

  f.post("@Stale this names only you");
  assert.equal(f.signals(stale.identityId), 0, "a direct mention of a quiet agent writes no wake");
  assert.equal(f.activity("stale"), 0);
  assert.equal(f.deliveries(stale.identityId), 0);
  assert.equal(f.signals(fresh.identityId), 1, "the listening agent is not woken by someone else's mention");
  assert.equal(f.deliveries(fresh.identityId), 2, "a listening subscriber still receives the later post");
  assert.equal(f.deliveries(push.identityId), 2, "a push-only subscriber has no wake census row and still receives the post");
});

test("a poll stamped in another room does not keep this room's fan-out", t => {
  const f = setup(t);
  const agent = f.link("Scoped", "scoped");
  f.store.agentHeartbeats.heartbeat({ agentId: agent.identityId, hostId: "scoped-host", mode: "pull-only" });
  f.store.db.prepare("UPDATE agent_wake_polls SET last_polled_at=? WHERE agent_id=?")
    .run(f.store.now() - WAKEABLE_WINDOW_MS - 1, agent.identityId);
  f.store.agentHeartbeats.recordPollActivity(agent.identityId, f.store.now(), "other-room");
  subscribe(f.store, agent.identityId, "scoped");

  f.post("@Scoped from the other room");
  assert.equal(f.signals(agent.identityId), 0);
  assert.equal(f.activity("scoped"), 0);
  assert.equal(f.deliveries(agent.identityId), 0);

  f.store.agentHeartbeats.recordPollActivity(agent.identityId, f.store.now(), "commons");
  f.post("@Scoped now listening here");
  assert.equal(f.signals(agent.identityId), 1);
  assert.equal(f.activity("scoped"), 1);
  assert.equal(f.deliveries(agent.identityId), 1);
});
