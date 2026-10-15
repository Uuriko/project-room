// Issue #3219 (simplification decision #3): the guest self-serve door is
// CUT. Guests are owner-issued trial seats only (the GX guest-invite
// flow). This suite pins the removal and the deliberate keeps:
//   - POST /api/guest-invites/request answers plain 404, even with a
//     valid signed card, and guestInvites.requestSelfServe is gone.
//   - The GX flow (contract, owner mint, redeem) keeps working.
//   - The guest_selfserve / guest_selfserve_idem tables are retained as
//     inert legacy: existing seats expire naturally, no data is deleted,
//     and no code reads or writes the tables.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-selfserve-cut-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, ownerKey };
}

function selfServeCard(roomId = "commons") {
  const kp = generateKeyPair();
  const card = {
    agentId: `ss-${randomUUID().slice(0, 8)}`,
    name: "SelfServe",
    capabilities: ["chat"],
    publicKey: kp.publicKey,
    joinRequest: { roomId, requestId: randomUUID(), issuedAt: Date.now() },
  };
  return { ...card, signature: signCard({ agentId: card.agentId, card, privateKey: kp.privateKey }) };
}

test("the self-serve door answers 404, even with a valid signed card", async t => {
  const { store, request } = await serve(t);
  assert.equal(typeof store.guestInvites.requestSelfServe, "undefined");
  const credentialsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n;
  const res = await request("/api/guest-invites/request", { method: "POST", data: { card: selfServeCard() } });
  assert.equal(res.status, 404);
  const bare = await request("/api/guest-invites/request", { method: "POST", data: {} });
  assert.equal(bare.status, 404);
  // No seat, member, or credential was created by the refused calls.
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM guest_selfserve").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n, credentialsBefore);
});

test("the GX guest-invite flow keeps working unchanged", async t => {
  const { store, request, ownerKey } = await serve(t);
  const contract = await request("/api/guest-invites");
  assert.equal(contract.status, 200);
  const minted = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "cut check", expectedOwnerRevision: 0 },
  });
  assert.equal(minted.status, 201);
  const { code } = await minted.json();
  const identity = store.identities.create("Cut Check Guest");
  const keys = generateKeyPair();
  const cardBody = { name: "Cut Check Guest", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: code, card },
  });
  assert.equal(redeemed.status, 201);
});

test("the self-serve tables are retained as inert legacy (no data deletion)", async t => {
  const { store } = await serve(t);
  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'guest_selfserve%' ORDER BY name"
  ).all().map(r => r.name);
  assert.deepEqual(tables, ["guest_selfserve", "guest_selfserve_idem"]);
});
