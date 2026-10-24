// Public /agents and the anonymous directory document are an indexable
// listing. A public card is an opt-in (visibility public, self-published).
// QA, dogfood, and test identities stay off that listing, and a bio never
// carries an identity id or a parenthetical legal name — including rows
// written before this filter existed.
// The filter lives in server/public-directory-policy.mjs. This test drives
// it through GET /agents and GET /api/agent-directory, not the helper.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

async function startServer(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store: f.store };
}

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});

function card(name, description) {
  return {
    name,
    description,
    url: "https://agent.example.test",
    capabilities: ["chat"],
    version: "1.0.0",
  };
}

async function publish(origin, secret, agentId, name, description) {
  const body = card(name, description);
  const keyPair = generateKeyPair();
  const res = await post(origin, "/api/agent-directory/cards", {
    agentId,
    card: body,
    visibility: "public",
    publicKey: keyPair.publicKey,
    signature: signCard({ agentId, card: body, privateKey: keyPair.privateKey }),
  }, secret);
  assert.equal(res.status, 201, `${agentId} publish ${(await res.clone().json()).error?.code ?? ""}`);
  return res.json();
}

test("anonymous /agents and the public directory omit test identities and legal names", async t => {
  const { origin, store } = await startServer(t);
  const publisher = store.identities.create("lane publisher");
  const leaked = "Keeps the lane (Jordan Hale), identity id_AbCdEf12\u2026, ai_Zz99token.";

  await publish(origin, publisher.secret, "lane-keeper", "Lane Keeper", leaked);
  await publish(origin, publisher.secret, "qa-sentinel", "QA Sentinel", "Internal QA identity used on the lane.");
  await publish(origin, publisher.secret, "dogfood-peer", "Dogfood Peer", "Dogfood identity, not a public profile.");
  await publish(origin, publisher.secret, "test-runner", "Test Runner", "Test identity, not a public profile.");
  await publish(origin, publisher.secret, "contest-helper", "Contest Helper", "Mentions a QA-lane in passing.");
  await publish(origin, publisher.secret, "latest-notes", "Latest Notes", "Ships the latest notes.");

  // Rows already on disk, the way a card published before the filter still is.
  const insertEntry = store.db.prepare(`INSERT INTO public_directory_entries
    (agent_id, name, description, skills_json, identity_id, receipt_count, room_count, updated_at)
    VALUES (?, ?, ?, '[]', NULL, 0, 0, ?)`);
  insertEntry.run("qa-old", "QA Stale", "Old row (Mina Cho), identity id_Stale99\u2026", "2026-10-01T00:00:00.000Z");
  insertEntry.run("seeded-placeholder", "Seeded Placeholder", "Owner-seeded placeholder, not an opt-in.", "2026-10-01T00:00:00.000Z");
  insertEntry.run("room-only", "Room Only Agent", "Visible to room members, not the public page.", "2026-10-01T00:00:00.000Z");
  store.db.prepare(`INSERT INTO agent_directory_cards
    (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn, provenance)
    VALUES (?, ?, 'public', 'owner-seed', 0, 0, 0, 'seeded')`)
    .run("seeded-placeholder", JSON.stringify(card("Seeded Placeholder", "Owner-seeded placeholder, not an opt-in.")));
  store.db.prepare(`INSERT INTO agent_directory_cards
    (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn, provenance)
    VALUES (?, ?, 'room', 'owner-seed', 0, 0, 0, 'self')`)
    .run("room-only", JSON.stringify(card("Room Only Agent", "Visible to room members, not the public page.")));

  const page = await fetch(`${origin}/agents`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Lane Keeper/);
  assert.match(html, /Keeps the lane\./);
  assert.match(html, /Contest Helper/);
  assert.match(html, /QA-lane/);
  assert.match(html, /Latest Notes/);
  for (const leakedText of [
    "Jordan Hale", "id_AbCdEf12", "ai_Zz99token",
    "QA Sentinel", "qa-sentinel", "Dogfood", "dogfood-peer",
    "Test Runner", "test-runner", "QA Stale", "Mina Cho", "id_Stale99",
    "Seeded Placeholder", "Room Only Agent",
  ]) {
    assert.equal(html.includes(leakedText), false, leakedText);
  }

  const listed = await (await fetch(`${origin}/api/agent-directory`)).json();
  const ids = listed.agents.map(agent => agent.agentId).sort();
  assert.deepEqual(ids, ["contest-helper", "lane-keeper", "latest-notes"]);
  const keeper = listed.agents.find(agent => agent.agentId === "lane-keeper");
  assert.equal(keeper.name, "Lane Keeper");
  assert.equal(keeper.description, "Keeps the lane.");
  assert.equal(keeper.publicKey, null);
  assert.equal(keeper.signature, null);
  assert.equal(keeper.a2a.description, "Keeps the lane.");
  const helper = listed.agents.find(agent => agent.agentId === "contest-helper");
  assert.equal(typeof helper.publicKey, "string");

  const searched = await (await fetch(`${origin}/api/agent-directory?q=${encodeURIComponent("id_AbCdEf12")}`)).json();
  assert.deepEqual(searched.agents, []);

  assert.equal((await fetch(`${origin}/api/agents/directory/qa-sentinel`)).status, 404);
  assert.equal((await fetch(`${origin}/api/agents/directory/dogfood-peer`)).status, 404);
  const cardRes = await fetch(`${origin}/api/agents/directory/lane-keeper`);
  assert.equal(cardRes.status, 200);
  const cardBody = await cardRes.json();
  assert.equal(cardBody.description, "Keeps the lane.");
  assert.equal(JSON.stringify(cardBody).includes("Jordan Hale"), false);
  assert.equal(JSON.stringify(cardBody).includes("id_AbCdEf12"), false);
});
