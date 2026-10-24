// Regression specimen for issue #4493 (MIG-CONNECT-QA finding CQ-4): a
// room-scoped mcpToken (rak_ API key) that is expired, revoked, unknown, or
// malformed must receive the structured 401 the /mcp door already returns
// for a garbage bearer — never a dropped connection with no response. An
// agent resuming with an aged token (30-day TTL) must be able to tell
// "credential rejected" apart from "network failure".
//
// Every assertion runs over real HTTP against a booted createRoomServer:
// fetch resolving at all is half the contract (a dropped connection fails
// the test as a transport error); the other half is the exact envelope.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-stale-token-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function fixture(t) {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Stale token owner");
  const agent = store.identities.create("Stale token agent");
  const created = rooms.create(owner.secret, {
    roomId: "stale-token-room", title: "Stale token room", purpose: "stale-token 401 specimen",
    kind: "personal", displayName: "Stale token owner"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: agent.identityId, displayName: "Stale token agent", permissions: []
  });
  const roomId = created.roomId;
  const scopes = [`mcp:room:${roomId}`, "rooms:read", "rooms:write", "mcp:inbox", "mcp:wake", "heartbeats:report", "heartbeats:read"];
  const valid = store.agentPlugin.issueOnboardingMcpToken({ identityId: agent.identityId, roomId, label: "specimen" }).credential;
  const expired = "rak_" + store.agentPlugin.issueApiKey({
    identityId: agent.identityId, scopes, expiresAt: store.now() - 1000, label: "expired specimen"
  }).secret;
  const revokedIssued = store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes, label: "revoked specimen" });
  const revoked = "rak_" + revokedIssued.secret;
  store.agentPlugin.revokeApiKey({ identityId: agent.identityId, keyId: revokedIssued.keyId });
  return { origin, roomId, valid, expired, revoked };
}

async function postMcp(origin, credential, payload) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

const listCall = { jsonrpc: "2.0", id: "8", method: "tools/list" };

test("stale room tokens get the structured 401 at /mcp tools/list (CQ-4 shape)", async t => {
  const { origin, valid, expired, revoked } = await fixture(t);

  // Control: the live token reaches the member catalog.
  const control = await postMcp(origin, valid, listCall);
  assert.equal(control.status, 200);
  assert.ok(Array.isArray(control.body.result?.tools), "valid token lists tools");

  const classes = [
    ["expired", expired],
    ["revoked", revoked],
    ["unknown well-formed", "rak_" + "A".repeat(32)],
    ["malformed bad chars", "rak_!!!not-base64url!!!"],
    ["prefix only", "rak_"],
    ["short secret", "rak_abc"],
  ];
  for (const [label, credential] of classes) {
    const reply = await postMcp(origin, credential, listCall);
    assert.equal(reply.status, 401, `${label}: HTTP status`);
    assert.equal(reply.body.error?.code, -32001, `${label}: JSON-RPC auth code`);
    assert.equal(reply.body.error?.message, "Unknown or revoked identity credential", `${label}: structured message`);
  }
});

test("stale room tokens get the structured 401 at /mcp tools/call too", async t => {
  const { origin, roomId, expired, revoked } = await fixture(t);
  const call = {
    jsonrpc: "2.0", id: "9", method: "tools/call",
    params: { name: "room_check_access", arguments: { roomId } }
  };
  for (const [label, credential] of [["expired", expired], ["revoked", revoked]]) {
    const reply = await postMcp(origin, credential, call);
    assert.equal(reply.status, 401, `${label}: HTTP status`);
    assert.equal(reply.body.error?.code, -32001, `${label}: JSON-RPC auth code`);
    assert.equal(reply.body.error?.message, "Unknown or revoked identity credential", `${label}: structured message`);
  }
});
