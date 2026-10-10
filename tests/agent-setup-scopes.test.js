import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessRequests } from "../server/access-requests.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { connectRoom } from "../client/agent-setup.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";

// Wiring audit dead end #3: b42251c3 gated the MCP inbox/wake tools on the
// mcp:inbox / mcp:wake API-key scopes and gave them to the hosted onboarding
// token, but the CLI setup flow kept minting room keys without them. An agent
// that joined through `connectRoom` (approval path, no MCP token on the
// redeem response) could not read its own heartbeat or inbox over MCP.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "setup-scopes-")), store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store }); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, directory = join(root, "private");
  return { store, key, origin, connect: extra => connectRoom({ origin, directory, name: "Peer", accept: true, ...extra }) };
}
async function mcpCall(origin, token, name, args = {}) {
  const response = await fetch(`${origin}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream"
  }, body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }) });
  return response.json();
}
test("a key minted by CLI setup reaches the wake and inbox MCP tools like the onboarding token", async t => {
  const f = await fixture(t);
  const pending = await f.connect({ target: f.origin + "/#room/commons" });
  assert.equal(pending.status, "pending");
  new AccessRequests(f.store).decide(f.key, "commons", pending.requestId, { decision: "approve", permissions: [] });
  const connected = await f.connect({ target: f.origin + "/#room/commons" });
  assert.equal(connected.status, "connected");
  const { token } = readAgentConnection(connected.configDirectory);
  assert.ok(token.startsWith("rak_"));
  for (const name of ["heartbeat_get", "inbox_list_attachments"]) {
    const answer = await mcpCall(f.origin, token, name);
    assert.equal(answer.error, undefined, `${name}: ${JSON.stringify(answer.error)}`);
    assert.notEqual(answer.result?.isError, true, `${name}: ${JSON.stringify(answer.result)}`);
  }
  // Still room-bound: the setup key reaches its own room and nothing wider.
  const scopes = JSON.parse(f.store.db.prepare("SELECT scopes_json FROM agent_api_keys WHERE identity_id = ?").get(connected.identityId).scopes_json);
  assert.deepEqual([...scopes].sort(), ["heartbeats:read", "heartbeats:report", "mcp:inbox", "mcp:room:commons", "mcp:wake", "rooms:read", "rooms:write"]);
});
