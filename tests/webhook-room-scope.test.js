// A webhook subscription is one room. Fan-out used to select every enabled
// subscription and then keep any identity seated in the event's room, so a
// hook registered while working in one room also received message.posted
// from every other room that identity belonged to.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

const HOOK = "https://room-scope.example.test/hook";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "webhook-room-scope-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  installFakeWebhookDns(store);
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

async function twoRooms(t) {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Scope Owner");
  rooms.create(owner.secret, { roomId: "room-a", title: "A", purpose: "scope", kind: "personal", displayName: "Scope Owner" });
  rooms.create(owner.secret, { roomId: "room-b", title: "B", purpose: "scope", kind: "personal", displayName: "Scope Owner" });
  const agent = store.identities.create("Scope Agent");
  for (const roomId of ["room-a", "room-b"]) {
    store.identities.link(owner.secret, roomId, { identityId: agent.identityId, displayName: "Scope Agent", permissions: [] });
  }
  const post = (roomId, body) => store.command(owner.secret, roomId, {
    id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body },
  });
  const deliveries = url => store.db.prepare(
    `SELECT d.room_id AS roomId FROM agent_webhook_deliveries d
     JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id
     WHERE s.url = ? AND d.event_type = 'message.posted'`).all(url);
  return { origin, store, agent, post, deliveries };
}

test("a subscription delivers its room and not the identity's other room", async t => {
  const { store, agent, post, deliveries } = await twoRooms(t);
  store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: HOOK, events: ["message.posted"], roomId: "room-a",
  });
  post("room-b", "other room");
  assert.deepEqual(deliveries(HOOK), [], "a room-a subscription must not journal room-b");
  post("room-a", "this room");
  assert.deepEqual(deliveries(HOOK).map(row => row.roomId), ["room-a"]);
});

test("a legacy subscription with no room delivers nothing", async t => {
  const { store, agent, post, deliveries } = await twoRooms(t);
  const { subscription } = store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: HOOK, events: ["message.posted"], roomId: "room-a",
  });
  store.db.prepare("UPDATE agent_webhook_subs SET room_id = NULL WHERE subscription_id = ?").run(subscription.subscriptionId);
  post("room-a", "still this room");
  post("room-b", "and the other");
  assert.deepEqual(deliveries(HOOK), [], "a subscription with no room must not receive either room");
});

test("the same url can subscribe to two rooms, and a room-scoped key stays on its room", async t => {
  const { origin, store, agent, post, deliveries } = await twoRooms(t);
  const subscribe = (secret, body) => fetch(`${origin}/api/agent-webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const missing = await subscribe(agent.secret, { url: HOOK, events: ["message.posted"] });
  assert.equal(missing.status, 422, "an identity in several rooms must name roomId");
  const first = await (await subscribe(agent.secret, { url: HOOK, events: ["message.posted"], roomId: "room-a" })).json();
  const second = await (await subscribe(agent.secret, { url: HOOK, events: ["message.posted"], roomId: "room-b" })).json();
  assert.equal(first.roomId, "room-a");
  assert.equal(second.roomId, "room-b");
  assert.notEqual(first.subscriptionId, second.subscriptionId);
  const again = await (await subscribe(agent.secret, { url: HOOK, events: ["message.posted"], roomId: "room-a" })).json();
  assert.equal(again.subscriptionId, first.subscriptionId, "retrying the same room returns the existing subscription");

  const scoped = store.agentPlugin.issueApiKey({
    identityId: agent.identityId, scopes: ["webhooks:manage", "mcp:room:room-a"],
  });
  const key = `rak_${scoped.secret}`;
  const implied = await (await subscribe(key, { url: "https://room-scope.example.test/scoped", events: ["message.posted"] })).json();
  assert.equal(implied.roomId, "room-a", "a single-room key defaults to its room");
  const crossed = await subscribe(key, { url: "https://room-scope.example.test/other", events: ["message.posted"], roomId: "room-b" });
  assert.equal(crossed.status, 422, "a single-room key cannot subscribe to another room");
  const stranger = await subscribe(agent.secret, { url: "https://room-scope.example.test/nope", events: ["message.posted"], roomId: "no-such-room" });
  assert.equal(stranger.status, 404);

  post("room-b", "only b");
  assert.deepEqual(deliveries("https://room-scope.example.test/scoped"), []);
  post("room-a", "only a");
  assert.deepEqual(deliveries("https://room-scope.example.test/scoped").map(row => row.roomId), ["room-a"]);
});
