import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { authorizeSpend, ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";

async function room(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = f.store.identities.create("spender");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "spender", displayName: "Spender", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

test("the preview shows the price and what the cap leaves, and predicts the refusal", async t => {
  const { f, call, agent, owner } = await room(t);
  ensureSpendGrantsSchema(f.store.db);
  const none = (await call(agent, "POST", "/spend-preview", { tool: "room_put_file" })).body;
  assert.equal(none.priceCents, 5);
  assert.equal(none.wouldRefuse, true);
  assert.equal(none.reason, "no_spend_grant");
  const ownerId = f.store.room("commons").state.room.ownerId;
  issueSpendGrant(f.store.db, "commons", "spender", { grantedBy: ownerId, capCents: "8", perTxCapCents: "5" });
  const ok = (await call(agent, "POST", "/spend-preview", { tool: "room_put_file" })).body;
  assert.equal(ok.label, "Costs $0.05");
  assert.equal(ok.wouldRefuse, false);
  assert.deepEqual(ok.member, { capCents: 8, leftCents: 8, leftAfterCents: 3 });
  assert.equal((await call(agent, "POST", "/spend-preview", { tool: "bounty_post" })).body.reason, "over_per_call_cap");
  authorizeSpend(f.store.db, { roomId: "commons", agentId: "spender", toolName: "room_put_file", priceCents: 5, nonce: "n1" });
  assert.equal((await call(agent, "POST", "/spend-preview", { tool: "room_put_file" })).body.reason, "member_cap_reached");
  assert.equal((await call(agent, "POST", "/spend-preview", { tool: "room_post_message" })).body.label, "Free");
  assert.equal((await call(owner, "POST", "/spend-preview", { tool: "room_put_file" })).body.owner, true);
  assert.equal((await call(agent, "POST", "/spend-preview", { tool: 7 })).status, 422);
});
