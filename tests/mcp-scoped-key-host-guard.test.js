// R269-1 (John's Tab): a room-scoped API key must not rewrite or replace an
// identity-owned wakeable host over hosted MCP. HTTP already refuses with
// scoped_key_wake_refused; MCP did so only when listenerLease was present.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { RoomStore } from "../server/store.mjs"; import { createRoomServer } from "../server/http.mjs"; import { AgentRooms } from "../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
function serve(t) {
  const d = mkdtempSync(join(tmpdir(), "mcp-scoped-host-")); const store = new RoomStore(join(d, "room.sqlite")); installFakeWebhookDns(store);
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
  const peer = store.identities.create("Lark");
  store.identities.link(owner.secret, "wake-den", { identityId: peer.identityId, displayName: "Lark", permissions: [] });
  const reg = await fetch(`${o}/api/agent-heartbeats`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${peer.secret}` },
    body: JSON.stringify({ hostId: "home", mode: "wakeable", wakeUrl: "https://hook.example.test/wake" }) });
  assert.equal(reg.status, 200);
  const key = store.agentPlugin.issueApiKey({ identityId: peer.identityId, scopes: ["mcp:wake", "mcp:room:wake-den"] });
  const home = () => store.db.prepare("SELECT mode, wake_url AS url FROM agent_hosts WHERE agent_id=? AND host_id='home'").get(peer.identityId);
  return { o, key: `rak_${key.secret}`, home };
}
for (const [name, args] of [
  ["wake_register", { hostId: "home", wakeUrl: "https://elsewhere.example.test/wake" }],
  ["heartbeat_set", { hostId: "home", mode: "pull-only" }],
  ["heartbeat_set", { hostId: "home", mode: "wakeable", wakeUrl: "https://elsewhere.example.test/wake" }],
  ["wake_clear", { hostId: "home" }]
]) test(`scoped key ${name} ${args.mode ?? ""} cannot rewrite the identity's wakeable host over MCP`, async t => {
  const { o, key, home } = await setup(t);
  const out = await mcp(o, name, args, key);
  assert.equal(out?.code ?? out?.error?.code, "scoped_key_wake_refused", JSON.stringify(out));
  assert.deepEqual({ ...home() }, { mode: "wakeable", url: "https://hook.example.test/wake" });
});
test("scoped key pull-only MCP heartbeat on a fresh host stays namespaced like HTTP", async t => {
  const { o, key, home } = await setup(t);
  const out = await mcp(o, "heartbeat_set", { hostId: "room-poller", mode: "pull-only" }, key);
  assert.equal(out.host.hostId, "room-poller");
  assert.deepEqual({ ...home() }, { mode: "wakeable", url: "https://hook.example.test/wake" });
});

test("scoped key heartbeat_get over MCP reads the scoped presence view, not the identity's hosts", async t => {
  const { o, key } = await setup(t);
  await mcp(o, "heartbeat_set", { hostId: "room-poller", mode: "pull-only" }, key);
  const out = await mcp(o, "heartbeat_get", {}, key);
  const text = JSON.stringify(out);
  assert.equal(text.includes("hook.example.test"), false, text);
  assert.equal((out.hosts ?? []).some(h => h.hostId === "home"), false, text);
});
