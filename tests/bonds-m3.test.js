// M3 (#870 follow-up): _resolvePeer is no longer an identity-existence oracle,
// proposals require a shared room, and incoming proposals are capped per
// recipient. Uniform 404 peer_not_found for nonexistent AND roomless targets.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { MAX_INCOMING_PROPOSALS } from "../server/bonds.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

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

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body)
});

async function jsonOf(res) {
  return { status: res.status, body: await res.json() };
}

async function admit(origin, roomId, ownerSecret, identity, label) {
  const requestId = randomUUID();
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: identity.identityId, displayName: label,
    requestedPermissions: ["accept_work"], note: null, requestId
  });
  assert.equal(reqRes.status, 201, label);
  const decide = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null
  }, ownerSecret);
  assert.equal(decide.status, 200, label);
}

async function setup(t) {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("m3 owner");
  const roomId = "m3-room";
  const created = await post(origin, "/api/agent-rooms", {
    roomId, title: "M3", purpose: "probe", kind: "personal", displayName: "Owner"
  }, owner.secret);
  assert.equal(created.status, 201);
  const command = (secret, type, data) => post(origin, `/api/rooms/${roomId}/commands`, {
    id: randomUUID(), type, data
  }, secret);
  return { origin, roomId, owner, command, fixture };
}

test("roomless and nonexistent targets fail with one uniform peer_not_found", async t => {
  const { origin, roomId, owner, command, fixture } = await setup(t);
  const roomless = fixture.store.identities.create("m3 roomless"); // never joins any room

  const toRoomless = await jsonOf(await command(owner.secret, "bond.propose", { to: roomless.identityId }));
  assert.equal(toRoomless.status, 404);
  assert.equal(toRoomless.body.error.code, "peer_not_found");

  const toMissing = await jsonOf(await command(owner.secret, "bond.propose", { to: "ai_does_not_exist_m3" }));
  assert.equal(toMissing.status, 404);
  assert.equal(toMissing.body.error.code, "peer_not_found");

  // Identical error shape: no existence signal in code or message.
  assert.deepEqual(toRoomless.body.error, toMissing.body.error);

  // Co-member identity still resolves and proposes.
  const friend = fixture.store.identities.create("m3 friend");
  await admit(origin, roomId, owner.secret, friend, "Friend");
  const ok = await jsonOf(await command(owner.secret, "bond.propose", { to: friend.identityId }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.event.type, "bond.proposed");
});

test("incoming pending proposals are capped per recipient", async t => {
  const { origin, roomId, owner, command, fixture } = await setup(t);
  const target = fixture.store.identities.create("m3 target");
  await admit(origin, roomId, owner.secret, target, "Target");

  // Link proposers through the store directly: the HTTP access-request path
  // rate-limits long before this loop reaches the bond cap.
  let lastStatus = 201;
  for (let i = 0; i < MAX_INCOMING_PROPOSALS + 2 && lastStatus === 201; i++) {
    const proposer = fixture.store.identities.create(`m3 proposer ${i}`);
    const linked = fixture.store.identities.link(owner.secret, roomId, {
      identityId: proposer.identityId, displayName: `P${i}`, permissions: ["accept_work"]
    });
    // #953: new members default to t1_readonly; proposers need write access for bond.propose
    setTier(fixture.store.db, roomId, linked.memberId, "t2_standard", { updatedBy: "owner", nowMs: fixture.store.now() });
    const res = await jsonOf(await command(proposer.secret, "bond.propose", { to: target.identityId }));
    lastStatus = res.status;
    if (res.status !== 201) assert.equal(res.body.error.code, "bond_rate_limited");
  }
  assert.equal(lastStatus, 429);
});
