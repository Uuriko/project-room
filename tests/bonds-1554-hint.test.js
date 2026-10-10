// #1554: bond_propose to an existing-but-unlinked identity must return a
// 404 whose message is true in every refusal case (already: "cannot resolve
// to an available agent peer") AND carry recoverable hint/next guidance —
// on the HTTP envelope and in the MCP tool-error envelope.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";

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

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body)
});

const mcp = (origin, name, args, secret) => post(origin, "/room/mcp", {
  jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args }
}, secret).then(async res => ({ status: res.status, body: await res.json() }));

async function setup(t) {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("1554 owner");
  const roomId = "b1554-room";
  const created = await post(origin, "/api/agent-rooms", {
    roomId, title: "B1554", purpose: "probe", kind: "personal", displayName: "Owner"
  }, owner.secret);
  assert.equal(created.status, 201);
  const roomless = fixture.store.identities.create("1554 roomless"); // never joins any room
  return { origin, roomId, owner, roomless };
}

test("#1554: agentErrorAx gives peer_not_found a recoverable hint/next", () => {
  const ax = agentErrorAx({ httpStatus: 404, code: "peer_not_found" });
  assert.equal(ax.reason, "peer_not_found");
  assert.ok(typeof ax.hint === "string" && ax.hint.length > 0, "hint must teach the fix");
  assert.ok(validAgentNext(ax.next), "next must be valid agent steps");
  assert.match(ax.hint, /room-linked peer|join/i);
});

test("#1554: HTTP bond.propose 404 carries hint/next without leaking existence", async t => {
  const { origin, roomId, owner, roomless } = await setup(t);
  const command = (secret, data) => post(origin, `/api/rooms/${roomId}/commands`, {
    id: randomUUID(), type: "bond.propose", data
  }, secret).then(async res => ({ status: res.status, body: await res.json() }));

  const toRoomless = await command(owner.secret, { to: roomless.identityId });
  assert.equal(toRoomless.status, 404);
  assert.equal(toRoomless.body.error.code, "peer_not_found");
  assert.ok(typeof toRoomless.body.hint === "string" && toRoomless.body.hint.length > 0,
    `HTTP envelope must carry a hint, got ${JSON.stringify(toRoomless.body).slice(0, 200)}`);
  assert.ok(validAgentNext(toRoomless.body.next), "HTTP envelope must carry valid next steps");

  const toMissing = await command(owner.secret, { to: "ai_does_not_exist_1554" });
  assert.equal(toMissing.status, 404);
  // Uniform shape: the unlinked case is indistinguishable from the missing one.
  assert.deepEqual(toMissing.body.error, toRoomless.body.error);
  assert.equal(toMissing.body.hint, toRoomless.body.hint);
});

test("#1554: MCP bond_propose 404 carries hint/next in the tool-error envelope", async t => {
  const { origin, roomId, owner, roomless } = await setup(t);
  const res = await mcp(origin, "bond_propose", {
    roomId, id: randomUUID(), to: roomless.identityId, scopes: ["peer.card"]
  }, owner.secret);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const content = res.body.result?.structuredContent;
  assert.ok(content, `expected a structuredContent envelope, got ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.equal(content.status, 404);
  assert.equal(content.code, "peer_not_found");
  assert.doesNotMatch(content.message, /No such agent identity/);
  assert.ok(typeof content.hint === "string" && /room-linked peer/i.test(content.hint),
    `MCP envelope must carry a teaching hint, got ${JSON.stringify(content).slice(0, 300)}`);
  assert.ok(validAgentNext(content.next), "MCP envelope must carry valid next steps");
});
