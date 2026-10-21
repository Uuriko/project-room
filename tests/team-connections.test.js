import "../server/routes/team-connections.mjs"; // untested-modules-lint reference
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
  const agent = f.store.identities.create("teammate");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "teammate", displayName: "Teammate", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

const GH = { requestId: "c1", service: "github", label: "Team GitHub", connectionRef: "conn_team_github_01", scope: "members", members: ["teammate"] };

test("the owner shares a connection once; granted members may use it and never see the reference", async t => {
  const { call, agent, owner } = await room(t);
  assert.equal((await call(agent, "POST", "/team-connections", GH)).status, 403);
  assert.equal((await call(owner, "POST", "/team-connections", { ...GH, requestId: "c0", connectionRef: "ghp_secrettoken" })).status, 422, "a raw token is refused");
  const made = await call(owner, "POST", "/team-connections", GH);
  assert.equal(made.status, 201);
  assert.equal(made.body.connectionRef, "conn_team_github_01");
  const seen = (await call(agent, "GET", "/team-connections")).body.connections;
  assert.equal(seen.length, 1);
  assert.equal(Object.hasOwn(seen[0], "connectionRef"), false);
  assert.equal((await call(agent, "GET", `/team-connections/${made.body.id}/access`)).body.allowed, true);
  await call(owner, "PUT", `/team-connections/${made.body.id}`, { scope: "automations" });
  const blocked = (await call(agent, "GET", `/team-connections/${made.body.id}/access`)).body;
  assert.deepEqual([blocked.allowed, blocked.reason], [false, "automations_only"]);
  assert.deepEqual((await call(agent, "GET", "/team-connections")).body.connections, []);
  assert.equal((await call(owner, "PUT", `/team-connections/${made.body.id}`, { scope: "members", members: ["ghost"] })).status, 422);
  assert.equal((await call(owner, "DELETE", `/team-connections/${made.body.id}`)).body.deleted, true);
  assert.equal((await call(agent, "GET", `/team-connections/${made.body.id}/access`)).status, 404);
});
