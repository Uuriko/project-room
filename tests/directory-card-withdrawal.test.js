// RC-2026-09-19-084: DELETE /api/agent-directory/cards/{agentId} repeat
// withdrawal. docs/openapi.yaml documents 404 unknown_card for the withdraw
// route; the runtime returned 422 invalid_directory when the owner withdrew
// a card twice. The second DELETE must answer the documented contract.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

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

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});
const del = (origin, path, secret) => fetch(`${origin}${path}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${secret}` },
});
const errorCode = async res => (await res.json()).error?.code;

const fixtureCard = () => ({
  name: "Withdrawal Agent",
  description: "A synthetic test agent for the directory-card withdrawal contract.",
  url: "https://agent.example.test",
  capabilities: ["chat"],
  skills: ["fixtures"],
  version: "1.0.0",
});
const signedPublishBody = (agentId, card, keyPair) => ({
  agentId,
  card,
  publicKey: keyPair.publicKey,
  signature: signCard({ agentId, card, privateKey: keyPair.privateKey }),
  visibility: "public",
});

async function publishAndWithdraw(origin, identity, keyPair, agentId = "withdraw-agent") {
  const published = await post(origin, "/api/agent-directory/cards",
    signedPublishBody(agentId, fixtureCard(), keyPair), identity.secret);
  assert.equal(published.status, 201);
  const withdrawn = await del(origin, `/api/agent-directory/cards/${agentId}`, identity.secret);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), { agentId, withdrawn: true });
}

test("the owner withdrawing twice gets 404 unknown_card, not 422", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-withdraw-owner");
  const keyPair = generateKeyPair();
  await publishAndWithdraw(origin, identity, keyPair);

  const again = await del(origin, "/api/agent-directory/cards/withdraw-agent", identity.secret);
  assert.equal(again.status, 404);
  assert.equal(await errorCode(again), "unknown_card");
});

test("republish after withdrawal re-opens the card for another clean withdrawal", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-republish-owner");
  const keyPair = generateKeyPair();
  await publishAndWithdraw(origin, identity, keyPair);

  const republished = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("withdraw-agent", fixtureCard(), keyPair), identity.secret);
  assert.equal(republished.status, 201);
  const withdrawn = await del(origin, "/api/agent-directory/cards/withdraw-agent", identity.secret);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), { agentId: "withdraw-agent", withdrawn: true });
  const again = await del(origin, "/api/agent-directory/cards/withdraw-agent", identity.secret);
  assert.equal(again.status, 404);
  assert.equal(await errorCode(again), "unknown_card");
});

test("a non-owner withdrawing an already-withdrawn card still gets 404 unknown_card (no oracle)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const owner = f.store.identities.create("dir-withdraw-owner");
  const stranger = f.store.identities.create("dir-withdraw-stranger");
  const keyPair = generateKeyPair();
  await publishAndWithdraw(origin, owner, keyPair);

  const attempt = await del(origin, "/api/agent-directory/cards/withdraw-agent", stranger.secret);
  assert.equal(attempt.status, 404);
  assert.equal(await errorCode(attempt), "unknown_card");
});
