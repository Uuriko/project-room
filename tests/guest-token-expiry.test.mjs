// Crew D Lane 5: real guest-token expiry, end to end.
//
// Pins what a guest actually sees when its credential dies, and that the
// recovery paths work. Failing-first: the expired-token 401 must teach the
// recovery ("Guest credential expired…") instead of the generic dead-end
// ("Session or key expired or revoked" + "Keep your saved connection").
//
// Contract guarded:
//  - HTTP 401 + code "unauthenticated" for expired guest tokens (status and
//    code are unchanged — only the message gains the next step).
//  - The teaching message is guest-scoped: revoked guests and expired
//    non-guest credentials keep the generic message.
//  - Recovery: v1 re-redeem with a fresh code (same seat, reactivated),
//    self-serve re-join with a fresh joinRequest (same member, renewed).
//  - rotate after expiry 401s through authenticate (leak response only).
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
import { GUEST_SELF_SERVE_TTL_MS } from "../server/guest-invites.mjs";

const ROOM = "commons";
const ONE_HOUR = 3600 * 1000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-token-expiry-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
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
  return { store, origin, request, ownerKey, advance: ms => { clock += ms; }, now: () => clock };
}

async function mintInvite(request, ownerKey, extras = {}) {
  const res = await request(`/api/rooms/${ROOM}/guest-invites`, {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "expiry probe", expectedOwnerRevision: 0, ...extras },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function redeemGuest(request, store, code, name = "Probe") {
  const identity = store.identities.create(`${name}-${randomUUID().slice(0, 6)}`);
  const keys = generateKeyPair();
  const cardBody = { name, description: "expiry probe", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const res = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: code, card },
  });
  assert.equal(res.status, 201);
  return { ...(await res.json()), identity, card };
}

const postChat = (request, token, body) => request(`/api/rooms/${ROOM}/commands`, {
  method: "POST", token,
  data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body } },
});

test("expired guest token 401s with a recovery-teaching message (v1 invite path)", async t => {
  const { request, store, ownerKey, advance } = await serve(t);
  const invited = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invited.code);

  const live = await postChat(request, guest.token, "before expiry");
  assert.equal(live.status, 201, "live guest token posts");

  advance(ONE_HOUR + 1000);
  const dead = await postChat(request, guest.token, "after expiry");
  assert.equal(dead.status, 401);
  const body = await dead.json();
  assert.equal(body.error.code, "unauthenticated", "status code contract is unchanged");
  assert.match(body.error.message, /Guest credential expired/, "names the expiry");
  assert.match(body.error.message, /\/api\/guest-invites\/request/, "teaches the self-serve recovery");
  assert.match(body.error.message, /\/api\/guest-invites\/redeem/, "teaches the invite recovery");
  assert.doesNotMatch(body.error.message, /Session or key expired or revoked/, "replaces the dead-end message");
});

test("rotate with an expired guest token surfaces the same teaching 401", async t => {
  const { request, store, ownerKey, advance } = await serve(t);
  const invited = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invited.code);
  advance(ONE_HOUR + 1000);
  const rotated = await request("/api/guest-invites/rotate", {
    method: "POST", token: guest.token, data: { roomId: ROOM },
  });
  assert.equal(rotated.status, 401);
  const body = await rotated.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /Guest credential expired/, "rotate-after-expiry teaches instead of dead-ending");
});

test("revoked guest token keeps the generic 401 (teaching is expiry-scoped)", async t => {
  const { request, store, ownerKey } = await serve(t);
  const invited = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invited.code);
  const disc = await request(`/api/rooms/${ROOM}/guest-invites-disconnect`, {
    method: "POST", token: ownerKey, data: { memberId: guest.member.id },
  });
  assert.equal(disc.status, 200);
  const dead = await postChat(request, guest.token, "after disconnect");
  assert.equal(dead.status, 401);
  const body = await dead.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(body.error.message, "Session or key expired or revoked");
  assert.doesNotMatch(body.error.message, /Guest credential expired/, "revocation is not mislabeled as expiry");
});

test("expired non-guest credential keeps the generic 401", async t => {
  const { store, request, advance } = await serve(t);
  const shortKey = store.issueAccessKey(ROOM, "owner", 1000);
  advance(1001);
  const dead = await postChat(request, shortKey, "expired owner key");
  assert.equal(dead.status, 401);
  const body = await dead.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(body.error.message, "Session or key expired or revoked");
});

test("v1 recovery: fresh code + re-redeem after expiry reactivates the same seat", async t => {
  const { request, store, ownerKey, advance } = await serve(t);
  const invited = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invited.code);
  const memberId = guest.member.id;
  advance(ONE_HOUR + 1000);
  assert.equal((await postChat(request, guest.token, "expired")).status, 401);

  const fresh = await mintInvite(request, ownerKey, {});
  const again = await request("/api/guest-invites/redeem", {
    method: "POST", token: guest.identity.secret, data: { inviteCode: fresh.code, card: guest.card },
  });
  assert.equal(again.status, 200, "re-redeem of an expired seat answers 200");
  const value = await again.json();
  assert.equal(value.duplicate, true);
  assert.equal(value.member.id, memberId, "same identity reuses its guest seat");
  const back = await postChat(request, value.token, "recovered");
  assert.equal(back.status, 201, "the fresh credential works");
  assert.equal(store.room(ROOM).state.members[memberId].active, true, "the swept seat is reactivated");
});

function signedSelfServeCard(roomId, { name, keyPair, issuedAt, requestId, agentId } = {}) {
  const kp = keyPair ?? generateKeyPair();
  const card = {
    agentId: agentId ?? `ss-${randomUUID().slice(0, 8)}`,
    name: name ?? "SelfServe",
    capabilities: ["chat"],
    publicKey: kp.publicKey,
    joinRequest: { roomId, requestId: requestId ?? randomUUID(), issuedAt: issuedAt ?? Date.now() },
  };
  return { card: { ...card, signature: signCard({ agentId: card.agentId, card, privateKey: kp.privateKey }) }, keyPair: kp };
}

test("self-serve: expired credential 401s teaching, re-join renews the same member", async t => {
  const { request, advance, now } = await serve(t);
  const firstId = randomUUID();
  const { card, keyPair } = signedSelfServeCard(ROOM, { name: "SelfServe", requestId: firstId, issuedAt: now() });
  const first = await request("/api/guest-invites/request", { method: "POST", data: { card } });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const memberId = firstBody.member.id;

  advance(GUEST_SELF_SERVE_TTL_MS + 1000);
  const dead = await postChat(request, firstBody.token, "expired");
  assert.equal(dead.status, 401);
  const body = await dead.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /Guest credential expired/);
  assert.match(body.error.message, /\/api\/guest-invites\/request/, "points at the self-serve re-join");

  // Self-service recovery: a fresh signed joinRequest with a new requestId.
  const { card: card2 } = signedSelfServeCard(ROOM, {
    name: "SelfServe", keyPair, requestId: randomUUID(), agentId: card.agentId, issuedAt: now(),
  });
  const second = await request("/api/guest-invites/request", { method: "POST", data: { card: card2 } });
  assert.equal(second.status, 200, "re-join after expiry renews");
  const secondBody = await second.json();
  assert.equal(secondBody.renewed, true);
  assert.equal(secondBody.member.id, memberId, "same card key keeps the same member");
  const back = await postChat(request, secondBody.token, "renewed");
  assert.equal(back.status, 201, "the renewed credential works");
});
