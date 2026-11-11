// R273-1 (John's Tab): hosted MCP heartbeat_ack without a fencingToken must stay
// inside a room-scoped key's room, the same as POST /api/agent-heartbeats/ack.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { RoomStore } from "../server/store.mjs"; import { createRoomServer } from "../server/http.mjs"; import { AgentRooms } from "../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
function serve(t) {
  const d = mkdtempSync(join(tmpdir(), "mcp-scoped-ack-")); const store = new RoomStore(join(d, "room.sqlite")); installFakeWebhookDns(store);
  const rooms = new AgentRooms(store); const s = createRoomServer({ store });
  return new Promise(res => s.listen(0, "127.0.0.1", () => {
    t.after(async () => { s.closeStreams(); s.closeAllConnections(); await new Promise(r => s.close(r)); store.close(); rmSync(d, { recursive: true, force: true }); });
    res({ o: `http://127.0.0.1:${s.address().port}`, store, rooms });
  }));
}
async function mcp(o, name, args, k) {
  const r = await fetch(`${o}/room/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name, arguments: args } }) });
  return (await r.json()).result?.structuredContent;
}
async function setup(t) {
  const { o, store, rooms } = await serve(t);
  const owner = store.identities.create("Wren");
  rooms.create(owner.secret, { roomId: "wake-den", title: "W", purpose: "p", kind: "personal", displayName: "Wren" });
  rooms.create(owner.secret, { roomId: "other-den", title: "O", purpose: "p", kind: "personal", displayName: "Wren" });
  const peer = store.identities.create("Lark");
  for (const roomId of ["wake-den", "other-den"]) linkWithProof(store, owner.secret, roomId, peer, { displayName: "Lark", permissions: [] });
  // #3266: ackWakes enforces poll's registration gate — an identity no host
  // has reported for gets 404 agent_not_registered before scoping is even
  // evaluated. These tests are about the room scoping, so register a host.
  store.agentHeartbeats.heartbeat({ agentId: peer.identityId, hostId: "wake-den-host", mode: "pull-only" });
  const key = store.agentPlugin.issueApiKey({ identityId: peer.identityId, scopes: ["mcp:wake", "mcp:room:wake-den"] });
  const enqueue = (roomId, messageId) => store.agentHeartbeats.enqueueWake({ agentId: peer.identityId, kind: "mention", roomId, messageId }).signal;
  const pending = signalId => store.db.prepare("SELECT delivered_at AS d FROM agent_wake_signals WHERE signal_id=?").get(signalId)?.d == null;
  return { o, key: `rak_${key.secret}`, keyId: key.keyId ?? key.id, identityId: peer.identityId, store, enqueue, pending };
}
const idOf = signal => signal?.signalId ?? signal?.id ?? signal;
test("scoped key MCP heartbeat_ack without fencingToken cannot ack another room's wake", async t => {
  const { o, key, enqueue, pending } = await setup(t);
  const other = idOf(enqueue("other-den", "m-other"));
  const out = await mcp(o, "heartbeat_ack", { signalIds: [other] }, key);
  assert.deepEqual([...(out?.acknowledged ?? [])], [], JSON.stringify(out));
  assert.equal(pending(other), true, "other room's wake must stay queued");
});
test("scoped key MCP heartbeat_ack without fencingToken still acks its own room's wake", async t => {
  const { o, key, enqueue, pending } = await setup(t);
  const own = idOf(enqueue("wake-den", "m-own"));
  const out = await mcp(o, "heartbeat_ack", { signalIds: [own] }, key);
  assert.deepEqual([...(out?.acknowledged ?? [])], [own], JSON.stringify(out));
  assert.equal(pending(own), false);
});

test("revoked scoped key cannot heartbeat_ack over MCP, with or without fencingToken", async t => {
  const { o, key, keyId, identityId, store, enqueue, pending } = await setup(t);
  const own = idOf(enqueue("wake-den", "m-own"));
  store.agentPlugin.revokeApiKey({ identityId, keyId });
  for (const args of [{ signalIds: [own] }, { signalIds: [own], fencingToken: "stale-token" }]) {
    const out = await mcp(o, "heartbeat_ack", args, key);
    assert.equal((out?.acknowledged ?? []).length, 0, JSON.stringify(out));
  }
  assert.equal(pending(own), true);
});
