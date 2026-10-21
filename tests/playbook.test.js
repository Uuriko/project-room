import "../server/routes/playbook.mjs"; // untested-modules-lint reference
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
  const agent = f.store.identities.create("reader");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "reader", displayName: "Reader", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

test("the owner publishes playbook versions and agents see what changed", async t => {
  const { call, agent, owner } = await room(t);
  assert.deepEqual((await call(agent, "GET", "/playbook")).body, { roomId: "commons", playbook: null, changed: false, changelog: [] });
  const denied = await call(agent, "PUT", "/playbook", { requestId: "p0", body: "x", note: "x", baseVersion: 0 });
  assert.equal(denied.status, 403);
  const v1 = await call(owner, "PUT", "/playbook", { requestId: "p1", body: "1. Claim before editing.\n2. Smoke-check prod.", note: "First version", baseVersion: 0 });
  assert.equal(v1.status, 201);
  assert.equal(v1.body.playbook.version, 1);
  assert.equal((await call(owner, "PUT", "/playbook", { requestId: "p1", body: "dup", note: "dup", baseVersion: 0 })).body.playbook.version, 1, "retry is idempotent");
  assert.equal((await call(owner, "PUT", "/playbook", { requestId: "p2", body: "stale", note: "stale", baseVersion: 0 })).status, 409);
  await call(owner, "PUT", "/playbook", { requestId: "p3", body: "1. Claim before editing.\n2. Smoke-check prod.\n3. No emoji.", note: "Add no-emoji rule", baseVersion: 1 });
  const seen = (await call(agent, "GET", "/playbook?since=1")).body;
  assert.equal(seen.playbook.version, 2);
  assert.equal(seen.changed, true);
  assert.deepEqual(seen.changelog.map(l => l.note), ["Add no-emoji rule"]);
  assert.equal((await call(agent, "GET", "/playbook?since=2")).body.changed, false);
  assert.match((await call(agent, "GET", "/playbook/versions/1")).body.playbook.body, /Smoke-check prod\.$/);
  assert.equal((await call(agent, "GET", "/playbook/versions/9")).status, 404);
  assert.equal((await call(agent, "GET", "/playbook?since=x")).status, 422);
  assert.equal((await call(owner, "PUT", "/playbook", { requestId: "p4", body: "y", baseVersion: 2 })).status, 422, "a note is required");
});
