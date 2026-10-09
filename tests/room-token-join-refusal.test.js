import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

// An agent that joined by invite holds only a room-scoped rak_ token. Using it
// to join a second room used to answer a bare "Active agent identity required",
// which reads like a dead credential. Every join door (share-link HTTP, invite
// redeem, MCP room_join) now names the real reason and a working recovery, and
// consumes nothing: the link and the invite code stay usable.
async function fixture(t) {
  const store = new RoomStore(":memory:");
  for (const id of ["commons", "lab"]) store.initialize(initialRoom(id));
  const keys = Object.fromEntries(["commons", "lab"].map(id => [id, store.issueAccessKey(id, "owner")]));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token) => {
    const response = await fetch(origin + path, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const invite = room => store.invites.create(keys[room], room, { profile: "chat", displayName: "Peer" });
  // Join commons the invite way: the response carries only a room token.
  const joined = await post("/api/agent-invites/redeem", { code: invite("commons").code, displayName: "Invited agent" });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const roomToken = joined.body.mcpToken.credential;
  assert.match(roomToken, /^rak_/);
  return { store, keys, origin, post, invite, roomToken };
}

const assertRoomTokenRefusal = (status, error, label) => {
  assert.equal(status, 401, label);
  assert.equal(error.code, "room_token_not_identity", label);
  assert.match(error.message, /room-scoped token/, label);
  assert.match(error.message, /cannot join another room/, label);
  assert.match(error.message, /agent invite code/, label);
  assert.doesNotMatch(error.message, /Active (agent )?identity/, label);
};

test("a room token on share-link join-agent is refused by name and leaves the link unused", async t => {
  const f = await fixture(t), linkToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(f.keys.lab, "lab", { requestId: "lab-door", linkToken,
    expiresAt: Date.now() + 3600000, maxJoins: 1, expectedMemberRevision: 0 });
  const refused = await f.post("/api/share-links/join-agent", { linkToken, displayName: "Invited agent" }, f.roomToken);
  assertRoomTokenRefusal(refused.status, refused.body.error, "join-agent");
  assert.equal(f.store.shareLinks.list(f.keys.lab, "lab").links[0].joins, 0);
  // A real identity secret still joins through the same single-use link.
  const identity = await f.post("/api/agent-identities", { displayName: "Fresh agent" });
  const ok = await f.post("/api/share-links/join-agent", { linkToken, displayName: "Fresh agent" }, identity.body.secret);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.roomId, "lab");
});

test("a room token on invite redeem is refused by name and the code is not burned", async t => {
  const f = await fixture(t), { code } = f.invite("lab");
  const refused = await f.post("/api/agent-invites/redeem", { code, displayName: "Invited agent" }, f.roomToken);
  assertRoomTokenRefusal(refused.status, refused.body.error, "redeem");
  // The recovery the message names works: redeem the same code with no bearer.
  const recovered = await f.post("/api/agent-invites/redeem", { code, displayName: "Invited agent" });
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.body.roomId, "lab");
});

test("MCP room_join with a room token answers the same named refusal", async t => {
  const f = await fixture(t), { code } = f.invite("lab");
  const response = await fetch(f.origin + "/mcp", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${f.roomToken}`,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "room_join", arguments: { inviteCode: code } } }) });
  const rpc = await response.json();
  const result = rpc.result;
  assert.equal(result?.isError, true, JSON.stringify(rpc));
  const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
  assertRoomTokenRefusal(payload.status, payload, "mcp room_join");
  assert.equal(f.store.db.prepare("SELECT redeemed_at FROM agent_invite_codes").all().filter(r => r.redeemed_at != null).length, 1);
});
