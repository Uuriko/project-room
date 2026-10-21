import "../server/routes/group-review.mjs"; // untested-modules-lint reference
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
  const agent = f.store.identities.create("author");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "author", displayName: "Author", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const second = f.store.identities.create("critic");
  f.store.identities.link(f.keys.owner, "commons", { identityId: second.identityId, memberId: "critic", displayName: "Critic", permissions: ["accept_work"] });
  return { f, call, agent: agent.secret, critic: second.secret, owner: f.keys.owner };
}

test("a draft goes to several reviewers and their objections land on one record", async t => {
  const { call, agent, critic, owner } = await room(t);
  const made = await call(agent, "POST", "/reviews", { requestId: "d1", draft: "Plan: ship lean tools Friday.", reviewers: ["*"] });
  assert.equal(made.status, 201);
  assert.ok(made.body.reviewers.includes("critic"));
  assert.ok(!made.body.reviewers.includes("author"), "the author never reviews itself");
  const id = made.body.id;
  assert.equal((await call(agent, "POST", "/reviews", { requestId: "d1", draft: "again", reviewers: ["*"] })).body.id, id);
  assert.equal((await call(critic, "GET", "/reviews?mine=asked")).body.reviews.length, 1);
  assert.equal((await call(critic, "POST", `/reviews/${id}/objections`, { objections: ["Friday has no deployer", "Bench is 10 tasks only"] })).status, 200);
  assert.equal((await call(critic, "GET", "/reviews?mine=asked")).body.reviews.length, 0);
  assert.equal((await call(agent, "POST", `/reviews/${id}/objections`, { none: true })).status, 403);
  const others = made.body.reviewers.filter(m => m !== "critic");
  if (others.length) await call(owner, "POST", `/reviews/${id}/objections`, { none: true });
  const done = (await call(agent, "GET", `/reviews/${id}`)).body;
  assert.deepEqual(done.objections.map(o => o.text), ["Friday has no deployer", "Bench is 10 tasks only"]);
  assert.equal(done.complete, others.length <= 1);
});

test("bad reviewers and bad answers are refused", async t => {
  const { call, agent, critic } = await room(t);
  assert.equal((await call(agent, "POST", "/reviews", { requestId: "d2", draft: "x", reviewers: ["ghost"] })).status, 422);
  assert.equal((await call(agent, "POST", "/reviews", { requestId: "d3", draft: "x", reviewers: ["author"] })).status, 422);
  const { id } = (await call(agent, "POST", "/reviews", { requestId: "d4", draft: "x", reviewers: ["critic"] })).body;
  assert.equal((await call(critic, "POST", `/reviews/${id}/objections`, { objections: ["a", "b", "c", "d"] })).status, 422);
  assert.equal((await call(critic, "POST", `/reviews/${id}/objections`, { objections: [] })).status, 422);
  assert.equal((await call(critic, "POST", `/reviews/${id}/objections`, { none: true })).body.complete, true);
  assert.equal((await call(critic, "GET", "/reviews/rev_missing")).status, 404);
});
