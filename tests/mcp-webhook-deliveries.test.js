// W-32: webhook_deliveries is the MCP twin of the webhook delivery
// journal reads — GET /api/agent-webhooks/{subscriptionId}/deliveries,
// the identity-wide GET /api/agent-webhooks/deliveries and
// GET /api/agent-webhooks/dead-letter, and GET /api/agent-webhooks/metrics.
// The journal was HTTP-only, so an agent on hosted MCP could subscribe
// and list webhooks but had to leave the transport to debug a failing
// endpoint. These tests call the real hosted MCP door and pin: the
// per-subscription journal round-trips the same store rows HTTP reads,
// the identity-wide log + metrics read, the state filter (dead_letter
// is the dead-letter queue), and cross-identity reads failing as
// unknown_subscription with nothing leaked, exactly like HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

function serve(t) {
  const d = mkdtempSync(join(tmpdir(), "mcp-webhook-deliveries-"));
  const store = new RoomStore(join(d, "room.sqlite"));
  installFakeWebhookDns(store);
  const rooms = new AgentRooms(store);
  const s = createRoomServer({ store });
  return new Promise(res => s.listen(0, "127.0.0.1", () => {
    t.after(async () => { s.closeStreams(); s.closeAllConnections(); await new Promise(r => s.close(r)); store.close(); rmSync(d, { recursive: true, force: true }); });
    res({ o: `http://127.0.0.1:${s.address().port}`, store, rooms });
  }));
}

async function mcp(o, name, args, secret) {
  const r = await fetch(`${o}/room/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { isError: body.result?.isError === true || Boolean(body.error), value: body.result?.structuredContent ?? body.error ?? body.result };
}

async function setup(t) {
  const { o, store, rooms } = await serve(t);
  const owner = store.identities.create("Wren");
  rooms.create(owner.secret, { roomId: "hook-den", title: "H", purpose: "p", kind: "personal", displayName: "Wren" });
  const peer = store.identities.create("Lark");
  store.identities.link(owner.secret, "hook-den", { identityId: peer.identityId, displayName: "Lark", permissions: [] });
  const other = store.identities.create("Osprey");
  store.identities.link(owner.secret, "hook-den", { identityId: other.identityId, displayName: "Osprey", permissions: [] });
  const sub = await mcp(o, "webhook_subscribe", { url: "https://hooks.example.test/agent", events: ["message.posted"] }, peer.secret);
  assert.equal(sub.isError, false, JSON.stringify(sub.value));
  const subscriptionId = sub.value.subscriptionId;
  // Server-side dispatch writes the journal entry the owner can read,
  // the same seeding the HTTP journal test uses.
  const delivery = store.agentPlugin.buildWebhookDelivery(subscriptionId, { eventType: "message.posted", data: { messageId: "m1" } });
  store.agentPlugin.recordWebhookAttempt(delivery.deliveryId, { ok: false, error: "connection refused" });
  return { o, store, peer, other, subscriptionId, deliveryId: delivery.deliveryId };
}

test("webhook_deliveries reads the per-subscription journal over MCP", async t => {
  const { o, peer, subscriptionId, deliveryId } = await setup(t);
  const out = await mcp(o, "webhook_deliveries", { subscriptionId }, peer.secret);
  assert.equal(out.isError, false, JSON.stringify(out.value));
  assert.equal(out.value.subscriptionId, subscriptionId);
  assert.equal(out.value.deliveries.length, 1);
  const entry = out.value.deliveries[0];
  assert.equal(entry.deliveryId, deliveryId);
  assert.equal(entry.eventType, "message.posted");
  assert.equal(entry.state, "failed");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.error, "connection refused");
  assert.ok(!("secret" in entry) && !("signature" in entry) && !("url" in entry),
    "journal entries never carry secrets, signatures, or the endpoint URL");
});

test("webhook_deliveries identity-wide reads the log, the state filter, and metrics", async t => {
  const { o, peer, deliveryId } = await setup(t);
  const all = await mcp(o, "webhook_deliveries", {}, peer.secret);
  assert.equal(all.isError, false, JSON.stringify(all.value));
  assert.deepEqual(all.value.deliveries.map(d => d.deliveryId), [deliveryId]);
  assert.equal(all.value.metrics.byState.failed, 1, "metrics ride the identity-wide read, like GET /api/agent-webhooks/metrics");
  assert.equal(all.value.metrics.failedAwaitingRetry, 1);
  const failed = await mcp(o, "webhook_deliveries", { state: "failed" }, peer.secret);
  assert.deepEqual(failed.value.deliveries.map(d => d.deliveryId), [deliveryId]);
  const dead = await mcp(o, "webhook_deliveries", { state: "dead_letter" }, peer.secret);
  assert.deepEqual(dead.value.deliveries, [], "the dead-letter queue is the dead_letter state filter");
  const limited = await mcp(o, "webhook_deliveries", { limit: 1 }, peer.secret);
  assert.equal(limited.value.deliveries.length, 1);
});

test("webhook_deliveries refuses cross-identity and invalid reads like HTTP", async t => {
  const { o, peer, other, subscriptionId } = await setup(t);
  const cross = await mcp(o, "webhook_deliveries", { subscriptionId }, other.secret);
  assert.equal(cross.isError, true, JSON.stringify(cross.value));
  assert.match(JSON.stringify(cross.value), /unknown_subscription/, JSON.stringify(cross.value));
  const missing = await mcp(o, "webhook_deliveries", { subscriptionId: "sub_missing" }, peer.secret);
  assert.equal(missing.isError, true, JSON.stringify(missing.value));
  assert.match(JSON.stringify(missing.value), /unknown_subscription/, JSON.stringify(missing.value));
  const badState = await mcp(o, "webhook_deliveries", { state: "bogus" }, peer.secret);
  assert.equal(badState.isError, true, JSON.stringify(badState.value));
});
