// UT2 04-10 F1 (PR-2): the MCP directory-card write side did not exist.
// Production evidence (wave-2026-10-27-user-testing-2, lane 04-10): the full
// catalog's only card tool was the reader room_member_card; 14
// room_search_actions queries, 6 by-name guesses and 4 room_run_action
// attempts all returned unknown_tool, while the signed HTTP paths
// (POST /api/agent-directory/cards, DELETE /api/agent-directory/cards/:id)
// worked. These tests pin the MCP verbs over the same store calls.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-directory-card-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store });
  }));
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, isError: body.result?.isError === true };
}

async function listTools(origin, secret, profile = "full") {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "l", method: "tools/list", params: { profile } })
  });
  return (await response.json()).result?.tools ?? [];
}

const CARD = {
  name: "Directory MCP Agent",
  description: "Publishes its card over MCP.",
  capabilities: ["summarize", "search"],
  skills: ["web-search"],
  version: "1.0.0"
};

test("directory card publish, edit and withdraw all execute over MCP", async t => {
  const { origin, store } = await serve(t);
  const identity = store.identities.create("Card Owner");
  const keyPair = generateKeyPair();
  const agentId = "ut2-directory-mcp";

  const listed = await listTools(origin, identity.secret);
  for (const name of ["agent_directory_publish_card", "agent_directory_withdraw_card"])
    assert.ok(listed.some(tool => tool.name === name), `${name} must be listed in the full catalog`);

  const publishArgs = card => ({
    agentId, card, publicKey: keyPair.publicKey,
    signature: signCard({ agentId, card, privateKey: keyPair.privateKey })
  });

  const published = await call(origin, "agent_directory_publish_card", publishArgs(CARD), identity.secret);
  assert.equal(published.isError, false, JSON.stringify(published.body));
  assert.equal(published.value.agentId, agentId);
  assert.equal(published.value.card?.version ?? published.value.version, "1.0.0");

  // The HTTP read side sees the MCP-published card (one directory, two doors).
  const directoryDoc = await (await fetch(`${origin}/api/agent-directory`)).json();
  assert.ok(JSON.stringify(directoryDoc).includes(agentId), "published card is in the anonymous directory");

  // Edit is a re-publish with a fresh signature.
  const editedCard = { ...CARD, description: "Edited over MCP.", version: "1.0.1" };
  const edited = await call(origin, "agent_directory_publish_card", publishArgs(editedCard), identity.secret);
  assert.equal(edited.isError, false, JSON.stringify(edited.body));
  assert.equal(edited.value.card?.version ?? edited.value.version, "1.0.1");

  const withdrawn = await call(origin, "agent_directory_withdraw_card", { agentId }, identity.secret);
  assert.equal(withdrawn.isError, false, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.value.withdrawn, true);

  const afterDoc = await (await fetch(`${origin}/api/agent-directory`)).json();
  assert.ok(!JSON.stringify(afterDoc).includes(agentId), "withdrawn card leaves the directory");

  const again = await call(origin, "agent_directory_withdraw_card", { agentId }, identity.secret);
  assert.equal(again.isError, true, "a second withdraw reads as unknown_card");
  assert.equal(again.value.code, "unknown_card");
});

test("directory publish over MCP enforces signing and ownership", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Slug Owner");
  const other = store.identities.create("Slug Squatter");
  const keyPair = generateKeyPair();
  const agentId = "ut2-directory-owned";
  const args = (card, key) => ({
    agentId, card, publicKey: key.publicKey,
    signature: signCard({ agentId, card, privateKey: key.privateKey })
  });

  const badSignature = await call(origin, "agent_directory_publish_card",
    { agentId, card: CARD, publicKey: keyPair.publicKey, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" },
    owner.secret);
  assert.equal(badSignature.isError, true, "an invalid signature is refused");
  assert.equal(badSignature.value.code, "invalid_card_signature");

  const published = await call(origin, "agent_directory_publish_card", args(CARD, keyPair), owner.secret);
  assert.equal(published.isError, false, JSON.stringify(published.body));

  const squatterKeys = generateKeyPair();
  const squat = await call(origin, "agent_directory_publish_card", args(CARD, squatterKeys), other.secret);
  assert.equal(squat.isError, true, "another identity cannot take over the slug");
  assert.equal(squat.value.code, "card_owned_by_another_identity");

  const steal = await call(origin, "agent_directory_withdraw_card", { agentId }, other.secret);
  assert.equal(steal.isError, true, "another identity cannot withdraw the card");
  assert.equal(steal.value.code, "unknown_card");
});
