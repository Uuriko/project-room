// Plug-in funnel, end to end over a live HTTP server: an anonymous doc read,
// an identity mint, a room join, a first claim, a first receipt, and the
// aggregate read at GET /api/plugin-funnel. This is the proof that the
// hooks in server/http.mjs, server/agent-identities.mjs and
// server/work-claim-events.mjs actually fire on the real request paths.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return { store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` };
}

test("doc read -> mint -> join -> claim -> receipt flows into /api/plugin-funnel", async t => {
  const { store, ownerKey, origin } = await fixture(t);

  // 1. doc read: explicit text/plain gets the short packet (not the app redirect).
  const docRes = await fetch(`${origin}/llms.txt`, { headers: { accept: "text/plain" } });
  assert.equal(docRes.status, 200);

  // 2. identity mint over the HTTP door.
  const mintRes = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "funnel-bot" }),
  });
  assert.equal(mintRes.status, 201);
  const minted = await mintRes.json();
  assert.ok(minted.identityId, "mint returns an identity id");

  // 3. room join: the owner links the fresh identity into the room.
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: minted.identityId,
    displayName: "funnel-bot",
    permissions: ["accept_work", "complete_work"], // the contribute profile: board writes
  });
  const memberKey = store.issueAccessKey("commons", linked.memberId);
  const agent = new RoomAgentClient({ origin, roomId: "commons", token: memberKey });

  // 4. first claim.
  await agent.workClaimCreate({ id: "funnel-task", title: "Funnel task" });
  await agent.claimWorkItem("funnel-task", { leaseHours: 2 });

  // 5. first receipt: the owner moves through in_progress, then closes
  // their own claim (self_attested).
  await agent.updateWorkItem("funnel-task", { state: "in_progress" });
  await agent.updateWorkItem("funnel-task", { state: "done" });

  // 6. the aggregate read.
  const funnelRes = await fetch(`${origin}/api/plugin-funnel`);
  assert.equal(funnelRes.status, 200);
  const funnel = await funnelRes.json();
  assert.equal(funnel.stages.identity_mint.count, 1);
  assert.equal(funnel.stages.room_join.count, 1);
  assert.equal(funnel.stages.first_claim.count, 1);
  assert.equal(funnel.stages.first_receipt.count, 1);
  assert.equal(funnel.topOfFunnel.docReaders, 1);
  assert.equal(funnel.conversions.mintToJoin.rate, 1);
  assert.equal(funnel.conversions.joinToClaim.rate, 1);
  assert.equal(funnel.conversions.claimToReceipt.rate, 1);
  assert.equal(funnel.day7.eligible, 0, "the mint is fresh — nobody is day-7 eligible yet");
  assert.equal(funnel.cohorts.length, 1);
  assert.equal(funnel.cohorts[0].minted, 1);
  assert.ok(funnel.definitions.identity_mint.length > 0);
  JSON.parse(JSON.stringify(funnel));
});

test("GET /api/plugin-funnel refuses non-GET and never leaks per-agent rows", async t => {
  const { origin } = await fixture(t);
  const postRes = await fetch(`${origin}/api/plugin-funnel`, { method: "POST" });
  assert.equal(postRes.status, 405);
  const body = await (await fetch(`${origin}/api/plugin-funnel`)).json();
  const text = JSON.stringify(body);
  assert.ok(!/"identity_key"/.test(text), "no funnel keys leak");
  assert.ok(!/"memberId"/.test(text), "no member ids leak");
  assert.ok(!/"identityId"/.test(text), "no identity ids leak");
});
