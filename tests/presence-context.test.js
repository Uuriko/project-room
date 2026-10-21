// Presence v1: a heartbeat may carry machine, repo, branch and busy/idle,
// and presence (GET /presence and room_who) shows it with the member's
// current claim.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { checkHostContext } from "../server/agent-heartbeats.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const call = (origin, path, { method = "GET", body, secret } = {}) => fetch(`${origin}${path}`, {
  method,
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("checkHostContext keeps plain fields and rejects the rest", () => {
  assert.deepEqual(checkHostContext({ machine: " mac ", repo: "o/r", branch: "main", activity: "busy" }),
    { machine: "mac", repo: "o/r", branch: "main", activity: "busy" });
  assert.equal(checkHostContext(null), null);
  assert.throws(() => checkHostContext({ activity: "sleeping" }), /busy or idle/);
  assert.throws(() => checkHostContext({ token: "x" }), /context fields/);
  assert.throws(() => checkHostContext({ branch: "a\nb" }), /printable/);
  assert.throws(() => checkHostContext({ repo: "x".repeat(121) }), /1 to 120/);
});

test("heartbeat context and the current claim show in room presence", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const identity = fixture.store.identities.create("context-agent");
  fixture.store.identities.link(fixture.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "ctxagent", displayName: "Ctx Agent", permissions: ["accept_work"],
  });
  const beat = await call(origin, "/api/agent-heartbeats", { method: "POST", secret: identity.secret,
    body: { hostId: "h1", mode: "pull-only", context: { machine: "studio-mac", repo: "Uuriko/project-room", branch: "grok/presence-v1", activity: "busy" } } });
  assert.equal(beat.status, 200, await beat.text());

  const opened = await call(origin, "/api/rooms/commons/work-claims", { method: "POST", secret: fixture.keys.owner,
    body: { id: "presence-task", title: "Presence task" } });
  assert.equal(opened.status, 201, await opened.text());
  const claimed = await call(origin, "/api/rooms/commons/work-claims/presence-task/claim", { method: "POST", secret: fixture.keys.owner, body: {} });
  assert.ok([200, 201].includes(claimed.status), await claimed.text());

  const read = async () => (await (await call(origin, "/api/rooms/commons/presence", { secret: fixture.keys.owner })).json())
    .members.find(m => m.memberId === "ctxagent");
  let agent = await read();
  assert.equal(agent.context.machine, "studio-mac");
  assert.equal(agent.context.repo, "Uuriko/project-room");
  assert.equal(agent.context.branch, "grok/presence-v1");
  assert.equal(agent.context.activity, "busy");
  assert.equal(agent.claim, null, "the agent holds no claim");

  // Omitted context keeps it; null clears it.
  await call(origin, "/api/agent-heartbeats", { method: "POST", secret: identity.secret, body: { hostId: "h1", mode: "pull-only" } });
  assert.equal((await read()).context.activity, "busy");
  await call(origin, "/api/agent-heartbeats", { method: "POST", secret: identity.secret, body: { hostId: "h1", mode: "pull-only", context: null } });
  assert.equal((await read()).context, null);

  const owner = (await (await call(origin, "/api/rooms/commons/presence", { secret: fixture.keys.owner })).json())
    .members.find(m => m.isOwner);
  assert.equal(owner.context, null, "humans carry no host context");
  assert.deepEqual(owner.claim, { id: "presence-task", title: "Presence task", state: "claimed" });

  const bad = await call(origin, "/api/agent-heartbeats", { method: "POST", secret: identity.secret,
    body: { hostId: "h1", mode: "pull-only", context: { activity: "napping" } } });
  assert.equal(bad.status, 422);
});
