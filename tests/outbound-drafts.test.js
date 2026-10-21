import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function room(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = f.store.identities.create("writer");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "writer", displayName: "Writer", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

const MAIL = { channel: "email", to: "customer@example.com", subject: "Your order", body: "It ships Friday." };

test("an outbound message is a draft by default and leaves only after approval", async t => {
  const { call, agent, owner } = await room(t);
  const made = await call(agent, "POST", "/outbound", { requestId: "m1", ...MAIL });
  assert.equal(made.status, 201);
  assert.equal(made.body.mode, "draft");
  const id = made.body.draft.id;
  assert.equal((await call(agent, "POST", "/outbound", { requestId: "m1", ...MAIL })).body.draft.id, id, "retry returns the same draft");
  assert.equal((await call(agent, "POST", `/outbound/${id}/sent`)).status, 409, "cannot send before approval");
  assert.equal((await call(agent, "POST", `/outbound/${id}/decision`, { decision: "approve" })).status, 403);
  const approved = await call(owner, "POST", `/outbound/${id}/decision`, { decision: "approve", body: "It ships Friday. Thanks!" });
  assert.equal(approved.body.state, "approved");
  assert.equal(approved.body.body, "It ships Friday. Thanks!");
  assert.equal((await call(agent, "POST", `/outbound/${id}/sent`)).body.state, "sent");
  assert.equal((await call(owner, "POST", `/outbound/${id}/decision`, { decision: "discard" })).status, 409);
  assert.equal((await call(agent, "GET", "/outbound?state=sent")).body.drafts.length, 1);
});

test("the owner can let one agent send without a draft", async t => {
  const { call, agent, owner } = await room(t);
  assert.equal((await call(agent, "GET", "/outbound-policy")).body.policies.find(p => p.memberId === "writer").allowSend, false);
  assert.equal((await call(agent, "PUT", "/outbound-policy", { requestId: "p1", agentId: "writer", allowSend: true })).status, 403);
  assert.equal((await call(owner, "PUT", "/outbound-policy", { requestId: "p2", agentId: "writer", allowSend: true })).status, 200);
  const sent = await call(agent, "POST", "/outbound", { requestId: "m2", ...MAIL });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.mode, "send");
  assert.deepEqual((await call(agent, "GET", "/outbound")).body.drafts, []);
  assert.equal((await call(agent, "POST", "/outbound", { requestId: "m3", ...MAIL, channel: "fax" })).status, 422);
  assert.equal((await call(owner, "PUT", "/outbound-policy", { requestId: "p3", agentId: "ghost", allowSend: true })).status, 404);
});
