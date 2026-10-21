import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { decide } from "../src/permission-modes.js";

async function room(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = f.store.identities.create("worker");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "worker", displayName: "Worker", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

test("decide: ask waits for everything but reads, safe runs safe actions, all runs everything", () => {
  assert.equal(decide("ask", "read"), "allow");
  assert.equal(decide("ask", "post_message"), "ask");
  assert.equal(decide("safe", "post_message"), "allow");
  assert.equal(decide("safe", "merge_pr"), "ask");
  assert.equal(decide("all", "merge_pr"), "allow");
  assert.equal(decide("weird", "read"), null);
  assert.equal(decide("ask", "Bad Action"), null);
});

test("the owner sets an agent's mode and the agent checks before acting", async t => {
  const { call, agent, owner } = await room(t);
  const first = await call(agent, "POST", "/permission-modes/check", { action: "post_message" });
  assert.equal(first.body.mode, "ask");
  assert.equal(first.body.decision, "ask");
  assert.match(first.body.next.path, /\/approvals$/);
  assert.equal((await call(agent, "PUT", "/permission-modes", { requestId: "m1", agentId: "worker", mode: "all" })).status, 403);
  assert.equal((await call(owner, "PUT", "/permission-modes", { requestId: "m2", agentId: "worker", mode: "safe" })).status, 200);
  assert.equal((await call(agent, "POST", "/permission-modes/check", { action: "post_message" })).body.decision, "allow");
  assert.equal((await call(agent, "POST", "/permission-modes/check", { action: "merge_pr" })).body.decision, "ask");
  assert.equal((await call(owner, "POST", "/permission-modes/check", { action: "merge_pr" })).body.decision, "allow", "the owner never asks itself");
  assert.equal((await call(agent, "GET", "/permission-modes")).body.modes.find(m => m.memberId === "worker").mode, "safe");
  assert.equal((await call(owner, "PUT", "/permission-modes", { requestId: "m3", agentId: "worker", mode: "yolo" })).status, 422);
  assert.equal((await call(owner, "PUT", "/permission-modes", { requestId: "m4", agentId: "toString", mode: "all" })).status, 404);
});
