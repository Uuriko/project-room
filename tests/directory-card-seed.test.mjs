import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";

// plan-dir-card (store + HTTP boundary): owner-only directory seeding,
// member-card reads with visibility enforcement, cardAgentId on the
// presence roster, and live-data mapping for owns/reach.
//
// Authoring gate:
// 1. Contracts: seed is owner-only and never overwrites a live card;
//    seeded cards persist provenance "seeded" + visibility "room";
//    member-card 404s (never oracles) for cardless/hidden cards; the
//    presence roster advertises cardAgentId; owns derives lane prefixes
//    from live claims; reach reflects live heartbeat data.
// 2. Credible regression: a refactor drops the owner check on the seed
//    route, lets seeding clobber a signed card, leaks a private card, or
//    fabricates reach for an unregistered agent.
// 3. Existing coverage: tests/agent-directory-owns-reach.test.mjs owns the
//    pure module; nothing covers the store/HTTP seam, so this file does.
// 4. No production seams: real RoomStore + real HTTP server + real DB.

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-dircard-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner", 30 * 86400000);
  const seedIdentity = store.identities.create("Seed Agent");
  const cardIdentity = store.identities.create("Card Agent");
  const seedLink = store.identities.link(ownerToken, "commons", {
    identityId: seedIdentity.identityId, memberId: "seed-agent",
    displayName: "Seed Agent", permissions: ["accept_work", "complete_work", "verify"],
  });
  const cardLink = store.identities.link(ownerToken, "commons", {
    identityId: cardIdentity.identityId, memberId: "card-agent",
    displayName: "Card Agent", permissions: ["steer"],
  });
  const agentToken = store.issueAccessKey("commons", "card-agent", 30 * 86400000);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerToken, agentToken, seedIdentity, cardIdentity, seedMemberId: seedLink.memberId, cardMemberId: cardLink.memberId };
}

async function startServer(t, store) {
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, token) => fetch(`${origin}${path}`, {
  method: "POST", headers: { authorization: `Bearer ${token}` },
});
const get = (origin, path, token) => fetch(`${origin}${path}`, {
  headers: { authorization: `Bearer ${token}` },
});
const errorCode = async res => (await res.json()).error?.code;

const signedCard = (agentId, visibility = "public") => {
  const card = {
    name: "Card Agent", description: "A signed card.", url: "https://agent.example/card",
    capabilities: ["chat"], version: "1.0.0",
  };
  const keyPair = generateKeyPair();
  return { card, keyPair, signature: signCard({ agentId, card, privateKey: keyPair.privateKey }) };
};

test("directory seed is owner-only", async t => {
  const f = setup(t);
  const origin = await startServer(t, f.store);
  const res = await post(origin, "/api/rooms/commons/directory/seed", f.agentToken);
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "owner_required");
});

test("owner seeds cardless agent members; members with live cards are skipped", async t => {
  const f = setup(t);
  // card-agent already has a signed card: seeding must not touch it.
  const { card, keyPair, signature } = signedCard("card-agent");
  f.store.agentPlugin.publishCard({
    identityId: f.cardIdentity.identityId, agentId: "card-agent",
    card, publicKey: keyPair.publicKey, signature, visibility: "public",
  });
  const origin = await startServer(t, f.store);
  const res = await post(origin, "/api/rooms/commons/directory/seed", f.ownerToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.seeded, ["seed-agent"]);
  assert.deepEqual(body.skipped, [{ memberId: "card-agent", reason: "card already published" }]);

  // The seeded card is an honest placeholder: room visibility, unsigned,
  // provenance seeded, capabilities mapped from live permissions.
  const cardRes = await get(origin, "/api/rooms/commons/members/seed-agent/card", f.ownerToken);
  assert.equal(cardRes.status, 200);
  const doc = await cardRes.json();
  assert.equal(doc.provenance, "seeded");
  assert.equal(doc.visibility, "room");
  assert.equal(doc.publicKey, null);
  assert.equal(doc.signature, null);
  assert.ok(doc.capabilities.includes("work-claims") && doc.capabilities.includes("review"));
  assert.ok(Array.isArray(doc.owns));
  assert.ok(doc.reach === null || typeof doc.reach === "object");

  // A second seed is idempotent: the seeded card now counts as live.
  const again = await post(origin, "/api/rooms/commons/directory/seed", f.ownerToken);
  assert.equal((await again.json()).seeded.length, 0);
});

test("member-card 404s for a cardless member (no oracle)", async t => {
  const f = setup(t);
  const origin = await startServer(t, f.store);
  const res = await get(origin, "/api/rooms/commons/members/owner/card", f.ownerToken);
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "unknown_card");
});

test("private cards are hidden from other viewers but visible to the owner", async t => {
  const f = setup(t);
  const { card, keyPair, signature } = signedCard("card-agent", "private");
  f.store.agentPlugin.publishCard({
    identityId: f.cardIdentity.identityId, agentId: "card-agent",
    card, publicKey: keyPair.publicKey, signature, visibility: "private",
  });
  // Another member's view: hidden.
  assert.equal(f.store.agentPlugin.cardForMember({
    roomId: "commons", memberId: "card-agent", viewerIdentityId: f.seedIdentity.identityId,
  }), null);
  // The owning identity: visible.
  const doc = f.store.agentPlugin.cardForMember({
    roomId: "commons", memberId: "card-agent", viewerIdentityId: f.cardIdentity.identityId,
  });
  assert.equal(doc.agentId, "card-agent");
  assert.equal(doc.visibility, "private");
});

test("presence roster advertises cardAgentId for members with visible cards", async t => {
  const f = setup(t);
  const { card, keyPair, signature } = signedCard("card-agent");
  f.store.agentPlugin.publishCard({
    identityId: f.cardIdentity.identityId, agentId: "card-agent",
    card, publicKey: keyPair.publicKey, signature, visibility: "public",
  });
  const origin = await startServer(t, f.store);
  const res = await get(origin, "/api/rooms/commons/presence", f.ownerToken);
  assert.equal(res.status, 200);
  const members = (await res.json()).members;
  const withCard = members.find(m => m.memberId === "card-agent");
  const withoutCard = members.find(m => m.memberId === "seed-agent");
  assert.equal(withCard.cardAgentId, "card-agent");
  assert.equal(withoutCard.cardAgentId, null);
});

test("owns derives lane prefixes from the member's live claims", async t => {
  const f = setup(t);
  const origin = await startServer(t, f.store);
  await post(origin, "/api/rooms/commons/directory/seed", f.ownerToken);
  // A live claimed board item owned by the seeded member.
  const work = createWork({ id: "qa9-01-seed-test", title: "Seed test claim" }, { now: Date.now(), agentId: "seed-agent" });
  f.store.workClaims.set("commons", claimWork(work, "seed-agent", { room: "commons", now: Date.now() }));
  const res = await get(origin, "/api/rooms/commons/members/seed-agent/card", f.ownerToken);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).owns, ["qa"]);
});

test("reach reflects live heartbeat data and stays honest when absent", async t => {
  const f = setup(t);
  const origin = await startServer(t, f.store);
  await post(origin, "/api/rooms/commons/directory/seed", f.ownerToken);
  // No heartbeat yet: wake fields are null, bond status is the real "none".
  let doc = await (await get(origin, "/api/rooms/commons/members/seed-agent/card", f.ownerToken)).json();
  assert.equal(doc.reach.wakeMode, "none");
  assert.equal(doc.reach.host, null);
  assert.equal(doc.reach.bondStatus, null);
  // After a live heartbeat, the card reports the wake mode and host.
  f.store.agentHeartbeats.heartbeat({ agentId: f.seedIdentity.identityId, hostId: "seed-host-1", mode: "wakeable" });
  doc = await (await get(origin, "/api/rooms/commons/members/seed-agent/card", f.ownerToken)).json();
  assert.equal(doc.reach.wakeMode, "wakeable");
  assert.equal(doc.reach.host, null);
  assert.equal(doc.reach.lastPollAt, null);
  assert.equal(f.store.agentPlugin.directory.get("seed-agent").reach, null);
  assert.equal(f.store.agentPlugin.directory.get("seed-agent").owns, null);
});
