// CURE-4437-2: bond events carry member text — bond.proposed stores an
// optional member-authored note (server/bonds.mjs _propose: the note is
// trimmed member text, included in the event data when non-empty) and
// bond.revoked's reducer (recordBond) requires a reason in the event data.
// Both were classed NO-TEXT by the first cure and reached agents unmarked
// on every door. Bonds are commanded only through the bond command layer
// (the MCP bond_propose / bond_revoke tools submit these commands), so the
// specimen drives that layer live over /room/mcp and reads the raw
// /events page as each party. Bond events are participant-visible only:
// the stranger control proves the stamp does not widen that.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body)
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {}
});

async function rpc(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  assert.equal(body.result?.isError, undefined, `${name} must not error: ${JSON.stringify(body).slice(0, 240)}`);
  return body.result?.structuredContent;
}

async function admit(origin, roomId, ownerSecret, identity, label) {
  const requestId = randomUUID();
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: identity.identityId, displayName: label,
    requestedPermissions: ["accept_work"], note: null, requestId
  }, identity.secret);
  assert.equal(reqRes.status, 201, label);
  const decide = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null
  }, ownerSecret);
  assert.equal(decide.status, 200, label);
  return (await decide.json()).memberId;
}

async function roomOf(t) {
  const fixture = createAcceptanceFixture();
  installFakeWebhookDns(fixture.store);
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = fixture.store.identities.create("bond owner");
  const friend = fixture.store.identities.create("bond friend");
  const stranger = fixture.store.identities.create("bond stranger");
  const roomId = "bond-trust-room";
  const created = await post(origin, "/api/agent-rooms", {
    roomId, title: "Bond trust", purpose: "probe", kind: "personal", displayName: "Owner"
  }, owner.secret);
  assert.equal(created.status, 201);
  const friendMemberId = await admit(origin, roomId, owner.secret, friend, "Friend");
  const strangerMemberId = await admit(origin, roomId, owner.secret, stranger, "Stranger");
  for (const memberId of [friendMemberId, strangerMemberId]) {
    setTier(fixture.store.db, roomId, memberId, "t2_standard", { updatedBy: "owner", nowMs: fixture.store.now() });
  }
  return { origin, roomId, owner, friend, stranger };
}

test("bond.proposed note and bond.revoked reason wrappers are trust-stamped for the peer", async t => {
  const { origin, roomId, owner, friend, stranger } = await roomOf(t);
  const proposed = await rpc(origin, "bond_propose", {
    roomId, id: randomUUID(), to: friend.identityId,
    note: "pair up for the trust specimen", scopes: ["peer.dm"]
  }, owner.secret);
  assert.equal(proposed.event.type, "bond.proposed");
  assert.equal(proposed.event.data.note, "pair up for the trust specimen");
  const bondId = proposed.event.data.bondId;

  const revoked = await rpc(origin, "bond_revoke", { roomId, id: randomUUID(), bondId }, owner.secret);
  assert.equal(revoked.event.type, "bond.revoked");
  assert.equal(revoked.event.data.reason, "revoked");

  const asFriend = await (await get(origin, `/api/rooms/${roomId}/events?limit=100`, friend.secret)).json();
  const proposedEntry = asFriend.events.find(({ event }) => event.type === "bond.proposed");
  assert.ok(proposedEntry, "the peer sees the proposal event");
  assert.equal(proposedEntry.untrusted, true, "the proposal's member note is marked for the peer");
  assert.equal(JSON.stringify(proposedEntry.event), JSON.stringify(proposed.event),
    "the served proposal envelope is byte-identical to the recorded event");
  const revokedEntry = asFriend.events.find(({ event }) => event.type === "bond.revoked");
  assert.ok(revokedEntry, "the peer sees the revocation event");
  assert.equal(revokedEntry.untrusted, true, "the revocation wrapper is marked for the peer");
  assert.equal(JSON.stringify(revokedEntry.event), JSON.stringify(revoked.event),
    "the served revocation envelope is byte-identical to the recorded event");

  const asOwner = await (await get(origin, `/api/rooms/${roomId}/events?limit=100`, owner.secret)).json();
  const ownProposal = asOwner.events.find(({ event }) => event.type === "bond.proposed");
  assert.ok(ownProposal && !("untrusted" in ownProposal), "the proposer's own proposal wrapper stays unmarked");

  const asStranger = await (await get(origin, `/api/rooms/${roomId}/events?limit=100`, stranger.secret)).json();
  assert.ok(!asStranger.events.some(({ event }) => event.type === "bond.proposed" || event.type === "bond.revoked"),
    "bond events stay participant-visible only; the stamp widens nothing");
});
