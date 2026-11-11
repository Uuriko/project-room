// R274-1 (John's Tab): hosted MCP webhook_subscribe/webhook_list/webhook_unsubscribe
// must hold an API key to the webhooks:manage scope, like /api/agent-webhooks.
// A webhook subscription is identity-wide: it fans out every room the identity
// is linked in, so a key scoped to one room (mcp:wake + mcp:room:<id>) must not
// be able to subscribe a URL to its other rooms' messages.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { RoomStore } from "../server/store.mjs"; import { createRoomServer } from "../server/http.mjs"; import { AgentRooms } from "../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
function serve(t) {
  const d = mkdtempSync(join(tmpdir(), "mcp-scoped-webhooks-")); const store = new RoomStore(join(d, "room.sqlite")); installFakeWebhookDns(store);
  const rooms = new AgentRooms(store); const s = createRoomServer({ store });
  return new Promise(res => s.listen(0, "127.0.0.1", () => {
    t.after(async () => { s.closeStreams(); s.closeAllConnections(); await new Promise(r => s.close(r)); store.close(); rmSync(d, { recursive: true, force: true }); });
    res({ o: `http://127.0.0.1:${s.address().port}`, store, rooms });
  }));
}
async function mcp(o, name, args, k) {
  const r = await fetch(`${o}/room/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { isError: body.result?.isError === true || Boolean(body.error), value: body.result?.structuredContent ?? body.error ?? null };
}
async function setup(t) {
  const { o, store, rooms } = await serve(t);
  const owner = store.identities.create("Wren");
  rooms.create(owner.secret, { roomId: "wake-den", title: "W", purpose: "p", kind: "personal", displayName: "Wren" });
  rooms.create(owner.secret, { roomId: "other-den", title: "O", purpose: "p", kind: "personal", displayName: "Wren" });
  const peer = store.identities.create("Lark");
  for (const roomId of ["wake-den", "other-den"]) linkWithProof(store, owner.secret, roomId, peer, { displayName: "Lark", permissions: [] });
  const scoped = store.agentPlugin.issueApiKey({ identityId: peer.identityId, scopes: ["mcp:wake", "mcp:room:wake-den"] });
  const subs = () => store.db.prepare("SELECT subscription_id AS id, url FROM agent_webhook_subs WHERE agent_id=?").all(peer.identityId);
  const postOther = body => store.command(owner.secret, "other-den", { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body } });
  const deliveriesTo = url => store.db.prepare(
    "SELECT d.payload_json FROM agent_webhook_deliveries d JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id WHERE s.url=?").all(url);
  return { o, store, peer, scopedKey: `rak_${scoped.secret}`, subs, postOther, deliveriesTo };
}
const HOOK = "https://scoped.example.test/hook";

test("room-scoped key cannot webhook_subscribe over MCP (HTTP parity), so other rooms' messages never reach its URL", async t => {
  const { o, scopedKey, subs, postOther, deliveriesTo } = await setup(t);
  const http = await fetch(`${o}/api/agent-webhooks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${scopedKey}` },
    body: JSON.stringify({ url: HOOK, events: ["message.posted"] }) });
  assert.equal(http.status, 403);
  const out = await mcp(o, "webhook_subscribe", { url: HOOK, events: ["message.posted"] }, scopedKey);
  assert.equal(out.isError, true, JSON.stringify(out.value));
  assert.deepEqual(subs(), []);
  postOther("other-den only");
  assert.equal(deliveriesTo(HOOK).length, 0, "no other-room message may be journaled for the scoped key's URL");
});

test("room-scoped key cannot list or remove the identity's webhook subscriptions over MCP", async t => {
  const { o, peer, scopedKey, subs } = await setup(t);
  const made = await mcp(o, "webhook_subscribe", { url: "https://identity.example.test/hook", events: ["message.posted"] }, peer.secret);
  assert.equal(made.isError, false, JSON.stringify(made.value));
  const listed = await mcp(o, "webhook_list", {}, scopedKey);
  assert.equal(listed.isError, true, JSON.stringify(listed.value));
  assert.ok(!JSON.stringify(listed.value).includes("identity.example.test"), "the identity's webhook URL must not be shown to a scoped key");
  const removed = await mcp(o, "webhook_unsubscribe", { subscriptionId: made.value.subscriptionId }, scopedKey);
  assert.equal(removed.isError, true, JSON.stringify(removed.value));
  assert.deepEqual(subs().map(s => s.url), ["https://identity.example.test/hook"]);
});

test("identity secret and a key with webhooks:manage keep webhook tools over MCP", async t => {
  const { o, store, peer, subs } = await setup(t);
  const managed = store.agentPlugin.issueApiKey({ identityId: peer.identityId, scopes: ["mcp:wake", "webhooks:manage"] });
  const k = `rak_${managed.secret}`;
  const viaKey = await mcp(o, "webhook_subscribe", { url: HOOK, events: ["message.posted"] }, k);
  assert.equal(viaKey.isError, false, JSON.stringify(viaKey.value));
  const listed = await mcp(o, "webhook_list", {}, k);
  assert.equal(listed.isError, false);
  assert.equal(listed.value.subscriptions.length, 1);
  const viaSecret = await mcp(o, "webhook_unsubscribe", { subscriptionId: viaKey.value.subscriptionId }, peer.secret);
  assert.equal(viaSecret.isError, false, JSON.stringify(viaSecret.value));
  assert.deepEqual(subs(), []);
});
