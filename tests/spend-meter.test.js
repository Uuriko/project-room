import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { authorizeSpend, ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";
import { meterLabel, meterLine } from "../src/spend-meter.js";

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

test("meterLine and meterLabel", () => {
  assert.equal(meterLabel(meterLine({ usedCents: 410, capCents: 500 })), "$4.10 of $5.00 (82%)");
  assert.equal(meterLine({ usedCents: 410, capCents: 500 }).warn, true);
  assert.equal(meterLabel(meterLine({ usedCents: 500, capCents: 500 })), "paused at $5.00 cap");
  assert.equal(meterLabel(meterLine({ usedCents: 120, capCents: null })), "$1.20, no cap");
});

test("the meter tracks an agent's grant and pauses at the cap; only the owner sees every agent", async t => {
  const { f, call, agent, owner } = await room(t);
  ensureSpendGrantsSchema(f.store.db);
  const ownerId = f.store.room("commons").state.room.ownerId;
  issueSpendGrant(f.store.db, "commons", "spender", { grantedBy: ownerId, capCents: "10", perTxCapCents: "5" });
  const fresh = (await call(agent, "GET", "/spend-meter")).body;
  assert.equal(fresh.agents.length, 1);
  assert.equal(fresh.agents[0].label, "$0.00 of $0.10 (0%)");
  assert.equal(fresh.paused, false);
  authorizeSpend(f.store.db, { roomId: "commons", agentId: "spender", toolName: "room_put_file", priceCents: 5, nonce: "n1" });
  assert.equal((await call(agent, "GET", "/spend-meter")).body.agents[0].percent, 50);
  authorizeSpend(f.store.db, { roomId: "commons", agentId: "spender", toolName: "room_put_file", priceCents: 5, nonce: "n2" });
  const capped = (await call(agent, "GET", "/spend-meter")).body;
  assert.equal(capped.agents[0].paused, true);
  assert.equal(capped.paused, true);
  assert.throws(() => authorizeSpend(f.store.db, { roomId: "commons", agentId: "spender", toolName: "room_put_file", priceCents: 5, nonce: "n3" }), e => e.status === 402);
  assert.equal((await call(owner, "GET", "/spend-meter")).body.agents[0].memberId, "spender");
  assert.equal((await call(owner, "GET", "/spend-meter")).body.room.label, "$0.00, no cap");
});
