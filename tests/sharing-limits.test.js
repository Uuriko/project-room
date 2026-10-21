import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { checkShare, normalizeShare } from "../src/sharing-limits.js";

async function room(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = f.store.identities.create("sharer");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "sharer", displayName: "Sharer", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

test("normalizeShare and checkShare", () => {
  assert.deepEqual(normalizeShare(["email", "code", "email"]), ["code", "email"]);
  assert.equal(normalizeShare(["passwords"]), null);
  assert.deepEqual(checkShare(["code"], ["code"]), { allowed: true, outside: [], ask: null });
  const ask = checkShare(["code"], ["code", "calendar"], { agentName: "Sharer", what: "Friday free slots" });
  assert.equal(ask.allowed, false);
  assert.deepEqual(ask.outside, ["calendar"]);
  assert.equal(ask.ask.tool, "room_ask_user");
  assert.equal(ask.ask.question, "May Sharer share your calendar in this room (Friday free slots)?");
  assert.equal(checkShare(["code"], []), null);
});

test("an agent shares code by default and asks before sharing the calendar", async t => {
  const { call, agent } = await room(t);
  const list = await call(agent, "GET", "/sharing-limits");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.limits.find(l => l.memberId === "sharer").share, ["code"]);
  const blocked = await call(agent, "POST", "/sharing-limits/check", { kinds: ["calendar"] });
  assert.equal(blocked.body.allowed, false);
  assert.match(blocked.body.ask.question, /calendar/);
  assert.equal((await call(agent, "PUT", "/sharing-limits", { requestId: "r1", share: ["code", "calendar"] })).status, 200);
  assert.equal((await call(agent, "POST", "/sharing-limits/check", { kinds: ["calendar"] })).body.allowed, true);
  assert.equal((await call(agent, "POST", "/sharing-limits/check", { kinds: ["nope"] })).status, 422);
});

test("only the room owner sets another member's limit", async t => {
  const { call, agent, owner } = await room(t);
  const ownerId = (await call(owner, "GET", "/sharing-limits")).body.limits.find(l => l.memberId !== "sharer").memberId;
  const denied = await call(agent, "PUT", "/sharing-limits", { requestId: "r2", share: ["email"], agentId: ownerId });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "owner_required");
  const set = await call(owner, "PUT", "/sharing-limits", { requestId: "r3", share: ["files"], agentId: "sharer" });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.share, ["files"]);
  assert.equal((await call(agent, "PUT", "/sharing-limits", { requestId: "r4", share: ["code"], agentId: "ghost" })).status, 404);
});
