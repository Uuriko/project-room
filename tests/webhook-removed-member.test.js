// A removed member loses room reads, and must also stop receiving the
// room. Removal keeps the identity_links row and sets members[id].active
// to false, so a webhook subscribed with "*" (every room) was still
// delivered message.posted. Fan-out and dispatch both require an active
// seat. A pending delivery is skipped and not sent. Re-adding the member
// resumes delivery. Mentioning the removed member does not fire agent.wake.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

const ROOM = "commons";
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };

function open(t) {
  const f = createAcceptanceFixture();
  installFakeWebhookDns(f.store);
  const server = createRoomServer({ store: f.store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    });
    resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      store: f.store,
      ownerKey: f.keys.owner,
    });
  }));
}

function seat(store, ownerKey, name, memberId) {
  const identity = store.identities.create(name);
  const linked = store.identities.link(ownerKey, ROOM, {
    identityId: identity.identityId, memberId, displayName: name, permissions: [],
  });
  return { identity, memberId: linked.memberId };
}

function setActive(store, ownerKey, memberId, active) {
  const member = store.room(ROOM).state.members[memberId];
  store.command(ownerKey, ROOM, {
    id: randomUUID(),
    type: "member.access_changed",
    data: {
      memberId,
      expectedMemberRevision: member.revision,
      permissions: member.permissions,
      active,
    },
  });
}

function postMessage(store, ownerKey, body, messageId = randomUUID()) {
  store.command(ownerKey, ROOM, {
    id: randomUUID(), type: "message.posted",
    data: { messageId, body },
  });
  return messageId;
}

const deliveryCount = (store, identityId, eventType) => store.db.prepare(
  "SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE agent_id=? AND (? IS NULL OR event_type=?)"
).get(identityId, eventType ?? null, eventType ?? null).n;

async function subscribeAllRooms(origin, secret, url, events) {
  const send = async body => {
    const response = await fetch(`${origin}/api/agent-webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  // "*" is every seated room. A build that has not accepted rooms yet
  // treats an omitted rooms field as that same all-rooms subscription.
  const starred = await send({ url, events, rooms: "*" });
  if (starred.status === 201) return starred.body;
  const legacy = await send({ url, events });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  return legacy.body;
}

test("a member removed before subscribing to every room receives nothing", async t => {
  const { origin, store, ownerKey } = await open(t);
  const { identity, memberId } = seat(store, ownerKey, "Lark", "lark");
  setActive(store, ownerKey, memberId, false);
  const sub = await subscribeAllRooms(origin, identity.secret, "https://removed-before.example.test/hook", ["message.posted"]);
  postMessage(store, ownerKey, "after removal");
  assert.equal(deliveryCount(store, identity.identityId, "message.posted"), 0);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE subscription_id=?"
  ).get(sub.subscriptionId).n, 0);
});

test("a subscription made while seated delivers nothing after removal, and delivers again once the member is re-added", async t => {
  const { origin, store, ownerKey } = await open(t);
  const { identity, memberId } = seat(store, ownerKey, "Lark", "lark");
  await subscribeAllRooms(origin, identity.secret, "https://removed-after.example.test/hook", ["message.posted"]);
  postMessage(store, ownerKey, "while seated");
  assert.equal(deliveryCount(store, identity.identityId, "message.posted"), 1, "an active member receives the post");
  setActive(store, ownerKey, memberId, false);
  postMessage(store, ownerKey, "after removal");
  assert.equal(deliveryCount(store, identity.identityId, "message.posted"), 1, "removal stops new deliveries");
  setActive(store, ownerKey, memberId, true);
  postMessage(store, ownerKey, "after re-add");
  assert.equal(deliveryCount(store, identity.identityId, "message.posted"), 2, "a re-added member receives again");
});

test("a pending delivery is skipped at dispatch after the member is removed, and no body is sent", async t => {
  const { origin, store, ownerKey } = await open(t);
  const { identity, memberId } = seat(store, ownerKey, "Lark", "lark");
  await subscribeAllRooms(origin, identity.secret, "https://pending-remove.example.test/hook", ["message.posted"]);
  postMessage(store, ownerKey, "queued while seated");
  assert.equal(deliveryCount(store, identity.identityId, "message.posted"), 1);
  setActive(store, ownerKey, memberId, false);
  const posted = [];
  const summary = await store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async (_url, init) => {
      posted.push(init.body);
      return { status: 200, headers: { get: () => null }, text: async () => "ok" };
    },
    now: store.now(),
    dnsResolvers: publicDns,
  });
  assert.equal(summary.delivered, 0);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(posted, [], "the removed member's pending body is not sent");
  const row = store.db.prepare(
    "SELECT state, attempts, last_error AS error FROM agent_webhook_deliveries WHERE agent_id=?"
  ).get(identity.identityId);
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.error, "skipped_not_member");
});

test("mentioning a removed member does not fire agent.wake", async t => {
  const { origin, store, ownerKey } = await open(t);
  const { identity, memberId } = seat(store, ownerKey, "Lark", "lark");
  store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "lark-host", mode: "wakeable" });
  await subscribeAllRooms(origin, identity.secret, "https://mention-wake.example.test/hook", ["agent.wake"]);
  const before = postMessage(store, ownerKey, "@Lark while seated", "mention-while-seated");
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=? AND message_id=?"
  ).get(identity.identityId, before).n, 1, "an active member is woken by a mention");
  assert.equal(deliveryCount(store, identity.identityId, "agent.wake"), 1);
  assert.equal(store.agentHeartbeats.pendingWakes(identity.identityId)
    .some(signal => signal.messageId === before), true);
  setActive(store, ownerKey, memberId, false);
  assert.equal(store.agentHeartbeats.pendingWakes(identity.identityId)
    .some(signal => signal.roomId === ROOM), false, "a heartbeat does not hand back the room after removal");
  const after = postMessage(store, ownerKey, "@Lark after removal", "mention-after-removal");
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=? AND message_id=?"
  ).get(identity.identityId, after).n, 0);
  assert.equal(deliveryCount(store, identity.identityId, "agent.wake"), 1, "removal does not fire agent.wake");
});

test("a guest seat with an expired pass receives no room webhook", async t => {
  const { store, ownerKey } = await open(t);
  const identity = store.identities.create("ExpiredGuest");
  const memberId = "expiredguest";
  store.db.prepare(`INSERT INTO guest_invites(
      id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id,
      issue_request_id, created_at, redeem_by, status, redeemed_at, redeemed_by_identity_id, redeemed_member_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("inv-expired", "b".repeat(64), ROOM, "contributor", 3_600_000, "ExpiredGuest", "owner",
      "req-expired", 1, 2, "redeemed", 1, identity.identityId, memberId);
  store.db.prepare(`INSERT INTO guest_members(member_id, room_id, guest_identity_id, tier, invite_id, created_at)
    VALUES(?,?,?,?,?,?)`).run(memberId, ROOM, identity.identityId, "contributor", "inv-expired", 1);
  store.command(ownerKey, ROOM, {
    id: randomUUID(), type: "member.added",
    data: { memberId, displayName: "ExpiredGuest", kind: "agent", permissions: [] },
  });
  store.db.prepare(
    `INSERT INTO credentials (hash, room_id, member_id, kind, expires_at, revoked)
     VALUES (?, ?, ?, 'access', ?, 0)`
  ).run("cred-expired", ROOM, memberId, store.now() - 1000);
  assert.equal(store.room(ROOM).state.members[memberId].active, true, "the roster seat is still active; the pass is what lapsed");
  store.agentPlugin.subscribeWebhook({
    identityId: identity.identityId, url: "https://expired-guest.example.test/hook", events: ["message.posted"],
  });
  postMessage(store, ownerKey, "guest pass lapsed");
  assert.equal(deliveryCount(store, identity.identityId, "message.posted"), 0);
});
