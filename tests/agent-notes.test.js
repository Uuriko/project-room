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
  const agent = f.store.identities.create("helper");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "helper", displayName: "Helper", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const other = f.store.identities.create("nosy");
  f.store.identities.link(f.keys.owner, "commons", { identityId: other.identityId, memberId: "nosy", displayName: "Nosy", permissions: ["accept_work"] });
  return { f, call, agent: agent.secret, nosy: other.secret, owner: f.keys.owner };
}

test("an agent keeps notes on its owner; the owner reads and edits them; nobody else sees them", async t => {
  const { call, agent, nosy, owner } = await room(t);
  const made = await call(agent, "POST", "/agents/helper/notes", { requestId: "n1", text: "Prefers small PRs with tests." });
  assert.equal(made.status, 201);
  assert.equal((await call(agent, "POST", "/agents/helper/notes", { requestId: "n1", text: "dup" })).body.id, made.body.id);
  assert.equal((await call(nosy, "GET", "/agents/helper/notes")).status, 404, "private to the agent and the owner");
  assert.equal((await call(nosy, "POST", "/agents/helper/notes", { requestId: "x", text: "hi" })).status, 404);
  const seen = (await call(owner, "GET", "/agents/helper/notes")).body.notes;
  assert.deepEqual(seen.map(n => n.text), ["Prefers small PRs with tests."]);
  const edited = await call(owner, "PUT", `/agents/helper/notes/${made.body.id}`, { text: "Prefers small PRs with tests. No emoji." });
  assert.match(edited.body.text, /No emoji/);
  assert.equal((await call(agent, "PUT", `/agents/helper/notes/${made.body.id}`, { text: "" })).status, 422);
  assert.equal((await call(owner, "DELETE", `/agents/helper/notes/${made.body.id}`)).body.deleted, true);
  assert.deepEqual((await call(agent, "GET", "/agents/helper/notes")).body.notes, []);
  assert.equal((await call(owner, "GET", "/agents/toString/notes")).status, 404);
});
