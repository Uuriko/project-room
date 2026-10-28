// R277-1 (John's Tab r277, owner ask Fo): subscribing the same (identity, url,
// event set) twice must return the existing subscription, not create a second
// row. A dropped 201 makes the client retry the same subscribe; two rows mean
// every room event is delivered to the URL once per duplicate.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { RoomStore } from "../server/store.mjs"; import { createRoomServer } from "../server/http.mjs"; import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
function serve(t) {
  const d = mkdtempSync(join(tmpdir(), "webhook-idempotent-")); const store = new RoomStore(join(d, "room.sqlite")); installFakeWebhookDns(store);
  const s = createRoomServer({ store });
  return new Promise(res => s.listen(0, "127.0.0.1", () => {
    t.after(async () => { s.closeStreams(); s.closeAllConnections(); await new Promise(r => s.close(r)); store.close(); rmSync(d, { recursive: true, force: true }); });
    res({ o: `http://127.0.0.1:${s.address().port}`, store });
  }));
}
async function setup(t) {
  const { o, store } = await serve(t);
  const agent = store.identities.create("Wren");
  const subs = () => store.db.prepare("SELECT subscription_id AS id FROM agent_webhook_subs WHERE agent_id=?").all(agent.identityId);
  const post = (url, body) => fetch(`${o}/api/agent-webhooks`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agent.secret}` }, body: JSON.stringify(body) });
  return { o, store, agent, subs, post };
}
const HOOK = "https://idempotent.example.test/hook";

test("identical HTTP subscribe returns the existing subscription, one row", async t => {
  const { store, agent, subs, post } = await setup(t);
  const a = await post(HOOK, { url: HOOK, events: ["message.posted"] });
  assert.equal(a.status, 201);
  const b = await post(HOOK, { url: HOOK, events: ["message.posted"] });
  assert.equal(b.status, 201);
  const va = await a.json(); const vb = await b.json();
  assert.equal(vb.subscriptionId, va.subscriptionId, "the retry must get the same subscription id");
  assert.equal(subs().length, 1, "a retried subscribe must not leave a second subscription row");
  const listed = store.agentPlugin.listWebhooks(agent.identityId);
  assert.equal((listed.subscriptions ?? listed).length, 1);
});

test("event order does not change identity; a different url does", async t => {
  const { subs, post } = await setup(t);
  await post(HOOK, { url: HOOK, events: ["message.posted", "agent.wake"] });
  const c = await post(HOOK, { url: HOOK, events: ["agent.wake", "message.posted"] });
  assert.equal(c.status, 201);
  assert.equal(subs().length, 1, "the same url and event set in another order must not add a row");
  await post(HOOK, { url: "https://idempotent.example.test/hook2", events: ["message.posted"] });
  assert.equal(subs().length, 2, "a different url is a different subscription");
});

test("a disabled subscription is re-enabled by the retry, not duplicated", async t => {
  const { store, agent, subs, post } = await setup(t);
  const made = await (await post(HOOK, { url: HOOK, events: ["message.posted"] })).json();
  store.agentPlugin.webhooks.setEnabled(made.subscriptionId, { agentId: agent.identityId, enabled: false });
  const again = await (await post(HOOK, { url: HOOK, events: ["message.posted"] })).json();
  assert.equal(again.subscriptionId, made.subscriptionId);
  assert.equal(again.enabled, true, "the re-subscribe must re-enable the subscription");
  const row = store.db.prepare("SELECT enabled FROM agent_webhook_subs WHERE subscription_id=?").get(made.subscriptionId);
  assert.equal(row.enabled, 1, "the re-enable must reach the durable row");
  assert.equal(subs().length, 1);
});

test("MCP webhook_subscribe dedupes like HTTP", async t => {
  const { o, agent, subs } = await setup(t);
  const mcp = async (name, args) => {
    const r = await fetch(`${o}/room/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agent.secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name, arguments: args } }) });
    const body = await r.json();
    return body.result?.structuredContent ?? body.error ?? null;
  };
  const a = await mcp("webhook_subscribe", { url: HOOK, events: ["message.posted"] });
  assert.ok(a && a.subscriptionId, JSON.stringify(a));
  const b = await mcp("webhook_subscribe", { url: HOOK, events: ["message.posted"] });
  assert.equal(b.subscriptionId, a.subscriptionId, "the retried MCP subscribe must return the existing subscription");
  assert.equal(subs().length, 1, "MCP dedupe must match HTTP: one row for one (identity, url, events)");
});
