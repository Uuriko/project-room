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

  // Identical error shape: no existence signal in code or message. The message
  // echoes the caller-supplied `to`, so strip it before comparing: everything
  // else must be byte-identical for roomless vs nonexistent targets.
  const stripTo = (err, to) => ({
    ...err,
    message: err.message.split(to).join("<to>")
  });
  assert.deepEqual(
    stripTo(toRoomless.body.error, roomless.identityId),
    stripTo(toMissing.body.error, "ai_does_not_exist_m3")
  );

  // Co-member identity still resolves and proposes.
  const friend = fixture.store.identities.create("m3 friend");
  await admit(origin, roomId, owner.secret, friend, "Friend");
  const ok = await jsonOf(await command(owner.secret, "bond.propose", { to: friend.identityId }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.event.type, "bond.proposed");
});

// QA7-14: the 404 peer_not_found for a stale/ex-peer DM target must teach.
// It names the attempted target, explains that the identity is either unknown
// or no longer a peer in this room, and gives the next steps (re-check
// membership, re-invite, propose a new bond) - while keeping the M3 uniform
// shape so the route stays useless as an existence oracle.
test("peer_not_found teaches: names the target, explains the ended-or-unknown relationship, gives next steps", async t => {
  const { origin, roomId, owner, command, fixture } = await setup(t);
  const roomless = fixture.store.identities.create("teach roomless"); // never joins any room
  const missing = "ai_teach_missing_9f2c7"; // never existed

  // A true ex-peer: admit them to the room, then unlink (owner-only).
  const exPeer = fixture.store.identities.create("teach ex-peer");
  await admit(origin, roomId, owner.secret, exPeer, "ExPeer");
  const unlinkRes = await fetch(`${origin}/api/rooms/${roomId}/identity-links`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner.secret}` },
    body: JSON.stringify({ identityId: exPeer.identityId })
  });
  assert.equal(unlinkRes.status, 200, "unlink the ex-peer");

  const cases = [
    ["bond.propose to roomless identity", "bond.propose", roomless.identityId],
    ["bond.propose to nonexistent identity", "bond.propose", missing],
    ["bond.propose to ex-peer", "bond.propose", exPeer.identityId],
    ["dm.posted to ex-peer", "dm.posted", exPeer.identityId],
  ];
  const stripped = [];
  for (const [label, cmd, to] of cases) {
    const data = cmd === "dm.posted"
      ? { to, body: "hello from the teaching test", messageId: randomUUID() }
      : { to };
    const r = await jsonOf(await command(owner.secret, cmd, data));
    assert.equal(r.status, 404, label);
    assert.equal(r.body.error.code, "peer_not_found", label);
    const msg = r.body.error.message;
    assert.ok(msg.includes(to), `${label}: names the attempted target: ${msg}`);
    assert.match(msg, /unknown|no longer/i, `${label}: explains unknown-or-ended relationship`);
    assert.match(msg, /next|invite|member|re-join|rejoin|bond/i, `${label}: gives next steps`);
    stripped.push(msg.split(to).join("<to>"));
  }
  // M3 anti-oracle preserved: roomless, ex-peer, and nonexistent targets
  // differ ONLY in the echoed caller-supplied target.
  for (const s of stripped.slice(1)) assert.equal(s, stripped[0]);
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
