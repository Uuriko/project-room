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
  const agent = f.store.identities.create("actor");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "actor", displayName: "Actor", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

test("a request becomes an approval card, the owner approves, and the agent acts", async t => {
  const { call, agent, owner } = await room(t);
  const made = await call(agent, "POST", "/approvals", { requestId: "q1", summary: "Book the team offsite room for Friday", action: { kind: "calendar.book", when: "Friday" } });
  assert.equal(made.status, 201);
  assert.equal(made.body.state, "pending");
  assert.equal(made.body.executorId, "actor");
  assert.equal((await call(agent, "POST", "/approvals", { requestId: "q1", summary: "again" })).body.id, made.body.id, "retry returns the same card");
  assert.deepEqual((await call(agent, "GET", "/approvals/ready")).body.ready, []);
  const id = made.body.id;
  const denied = await call(agent, "POST", `/approvals/${id}/decision`, { decision: "approve" });
  assert.equal(denied.status, 403);
  assert.equal((await call(agent, "POST", `/approvals/${id}/done`, { ok: true })).status, 409, "cannot act before approval");
  const approved = await call(owner, "POST", `/approvals/${id}/decision`, { decision: "approve", note: "go" });
  assert.equal(approved.body.state, "approved");
  const ready = (await call(agent, "GET", "/approvals/ready")).body.ready;
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].action, { kind: "calendar.book", when: "Friday" });
  assert.equal((await call(owner, "POST", `/approvals/${id}/done`, { ok: true })).status, 403, "only the executor reports");
  const done = await call(agent, "POST", `/approvals/${id}/done`, { ok: true, result: "Booked room 4" });
  assert.equal(done.body.state, "done");
  assert.deepEqual((await call(agent, "GET", "/approvals/ready")).body.ready, []);
  assert.equal((await call(owner, "POST", `/approvals/${id}/decision`, { decision: "deny" })).status, 409);
});

test("a denied card never reaches the ready list; bad input is refused", async t => {
  const { call, agent, owner } = await room(t);
  const { id } = (await call(agent, "POST", "/approvals", { requestId: "q2", summary: "Email the customer" })).body;
  assert.equal((await call(owner, "POST", `/approvals/${id}/decision`, { decision: "deny" })).body.state, "denied");
  assert.deepEqual((await call(agent, "GET", "/approvals/ready")).body.ready, []);
  assert.equal((await call(agent, "GET", "/approvals?state=denied")).body.approvals.length, 1);
  assert.equal((await call(agent, "GET", "/approvals?state=weird")).status, 422);
  assert.equal((await call(agent, "POST", "/approvals", { requestId: "q3" })).status, 422);
  assert.equal((await call(agent, "POST", "/approvals", { requestId: "q4", summary: "x", executorId: "ghost" })).status, 404);
  assert.equal((await call(owner, "POST", "/approvals/apv_missing/decision", { decision: "approve" })).status, 404);
});
