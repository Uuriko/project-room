import "../server/routes/routine-blueprints.mjs"; // untested-modules-lint reference
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
  const agent = f.store.identities.create("member1");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "member1", displayName: "Member1", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

test("a member posts a routine, others install it, and one edit reaches every install", async t => {
  const { call, agent, owner } = await room(t);
  const made = await call(agent, "POST", "/routine-blueprints", { requestId: "r1", name: "Call prep", schedule: "weekdays 08:30", steps: "Read the calendar. List open asks." });
  assert.equal(made.status, 201);
  assert.equal((await call(agent, "POST", "/routine-blueprints", { requestId: "r2", name: "Bad", schedule: "sometimes", steps: "x" })).status, 422);
  const id = made.body.id;
  assert.equal((await call(agent, "POST", `/routine-blueprints/${id}/install`, { as: "room" })).status, 403);
  await call(agent, "POST", `/routine-blueprints/${id}/install`, { as: "me" });
  await call(owner, "POST", `/routine-blueprints/${id}/install`, { as: "room" });
  let mine = (await call(agent, "GET", "/routines")).body.routines;
  assert.deepEqual(mine.map(r => r.runsAs).sort(), ["me", "room"]);
  assert.equal(mine.every(r => !r.updateAvailable), true);
  assert.equal((await call(agent, "PUT", `/routine-blueprints/${id}`, { steps: "Read the calendar. List open asks. Check CI." })).body.version, 2);
  mine = (await call(agent, "GET", "/routines")).body.routines;
  assert.equal(mine.every(r => r.updateAvailable), true);
  await call(agent, "POST", `/routine-blueprints/${id}/install`, { as: "me" });
  assert.equal((await call(agent, "GET", "/routines")).body.routines.find(r => r.runsAs === "me").updateAvailable, false);
  assert.equal((await call(agent, "GET", "/routine-blueprints")).body.blueprints[0].installs, 2);
  assert.equal((await call(owner, "PUT", `/routine-blueprints/${id}`, {})).status, 422);
  assert.equal((await call(owner, "POST", "/routine-blueprints/rtn_missing/install", { as: "me" })).status, 404);
});
