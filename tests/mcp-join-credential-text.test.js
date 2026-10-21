// MCP onboarding credentials (prod QA 2026-10-20): room_join and
// room_create hand back an identity secret or room token.
//    Like a minted invite code (#3750), those ride in structuredContent only
//    and are withheld from the text block hosts show and log.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-onboarding-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function http(origin, path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

const rpc = (origin, token, method, params) => http(origin, "/mcp", {
  method: "POST", token, body: { jsonrpc: "2.0", id: "1", method, ...(params ? { params } : {}) },
});

async function freshIdentity(origin, displayName) {
  const minted = await http(origin, "/api/agent-identities", { method: "POST", body: { displayName } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  return minted.json.secret;
}

test("room_join keeps the room token and identity secret out of the text block", async t => {
  const { origin, ownerKey } = await serve(t);
  const secret = await freshIdentity(origin, "Joining Agent");
  const invite = await http(origin, "/api/rooms/commons/agent-invites", { method: "POST", token: ownerKey, body: { profile: "chat" } });
  const joined = await rpc(origin, secret, "tools/call", { name: "room_join", arguments: { inviteCode: invite.json.code } });
  const result = joined.json.result;
  const credential = result.structuredContent?.mcpToken?.credential;
  assert.match(credential, /^rak_/, "structuredContent still carries the room token");
  const text = result.content.map(part => part.text).join("\n");
  assert.equal(text.includes(credential), false, "the room token is withheld from text");
  // keyId is the key's public identifier (also rak_-prefixed); only the credential is secret.
  assert.equal(text.includes(secret), false, "the caller's own secret never appears");
  assert.match(text, /withheld from this text — the value is in structuredContent\.mcpToken\.credential/);
});

test("room_create keeps any credential it returns out of the text block", async t => {
  const { origin } = await serve(t);
  const secret = await freshIdentity(origin, "Founding Agent");
  const created = await rpc(origin, secret, "tools/call", { name: "room_create", arguments: { title: "Agent den", purpose: "Ship the first post" } });
  const result = created.json.result;
  assert.notEqual(result.isError, true, JSON.stringify(created.json));
  const text = result.content.map(part => part.text).join("\n");
  assert.equal(text.includes(secret), false);
  const tokens = [result.structuredContent?.mcpToken?.credential, result.structuredContent?.roomToken, result.structuredContent?.identitySecret].filter(Boolean);
  for (const token of tokens) assert.equal(text.includes(token), false, "every returned credential is withheld from text");
});
