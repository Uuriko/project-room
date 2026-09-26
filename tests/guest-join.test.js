import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import {
  GUEST_SELF_SERVE_TTL_MS,
  GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM,
  GUEST_INVITE_HASH_PATH,
  GUEST_BADGE_SUFFIX,
} from "../server/guest-invites.mjs";
import { GUEST_AGENT_TOKEN_PREFIX, isGuestAgentMemberId } from "../server/guest-agent-links.mjs";

const ROOM = "commons";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-join-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
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
  return { store, origin, request, advance: ms => { clock += ms; } };
}

// A self-signed agent card carrying a joinRequest, signed the way an
// outside agent would: signCard over the card body (joinRequest included),
// signature attached as envelope.
function signedCard(roomId, { name, keyPair, issuedAt, requestId, agentId } = {}) {
  const kp = keyPair ?? generateKeyPair();
  const card = {
    agentId: agentId ?? `test-${randomBytes(4).toString("hex")}`,
    name: name ?? `Test Bot ${randomBytes(3).toString("hex")}`,
    capabilities: ["chat"],
    publicKey: kp.publicKey,
    joinRequest: { roomId, requestId: requestId ?? randomUUID(), issuedAt: issuedAt ?? Date.now() },
  };
  const signature = signCard({ agentId: card.agentId, card, privateKey: kp.privateKey });
  return { card: { ...card, signature }, keyPair: kp };
}

const postJoin = (request, card) => request("/api/guest-invites/request", { method: "POST", data: { card } });

test("self-serve request issues a badged read/chat guest pass", async t => {
  const { request, store } = await serve(t);
  const { card } = signedCard(ROOM);
  const res = await postJoin(request, card);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.token.startsWith(GUEST_AGENT_TOKEN_PREFIX), "ga1. bearer credential");
  assert.equal(body.room.id, ROOM);
  assert.equal(body.tier, "observer");
  assert.deepEqual(body.scopes, ["guest:read", "guest:post"]);
  assert.equal(body.account, false);
  assert.equal(body.selfServed, true);
  assert.equal(body.renewed, false);
  assert.equal(body.hashPath, GUEST_INVITE_HASH_PATH);
  // 24h TTL on the credential.
  const tokenHash = createHash("sha256").update(body.token).digest("hex");
  const row = store.db.prepare("SELECT * FROM credentials WHERE hash=?").get(tokenHash);
  assert.ok(row.expires_at - Date.now() > GUEST_SELF_SERVE_TTL_MS - 60_000);
  assert.ok(row.expires_at - Date.now() <= GUEST_SELF_SERVE_TTL_MS);
  // Key provenance: parent_hash is NULL (the key is not a credential), and
  // the member's identityId carries the card-key fingerprint.
  assert.equal(row.parent_hash, null);
  const keyHash = createHash("sha256").update(card.publicKey).digest("hex");
  const member = store.room(ROOM).state.members[body.member.id];
  assert.ok(isGuestAgentMemberId(member.id));
  assert.equal(member.identityId, `key:${keyHash.slice(0, 32)}`);
  assert.equal(member.kind, "agent");
  assert.deepEqual([...member.permissions], []);
  assert.ok(member.displayName.endsWith(GUEST_BADGE_SUFFIX), `badged: ${member.displayName}`);
});

test("a forged signature is rejected", async t => {
  const { request } = await serve(t);
  const { card } = signedCard(ROOM);
  const other = generateKeyPair();
  // Present a different key than the card was signed with.
  const forged = { ...card, publicKey: other.publicKey };
  const res = await postJoin(request, forged);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "card_invalid");
});

test("a tampered joinRequest breaks the signature", async t => {
  const { request } = await serve(t);
  const { card } = signedCard(ROOM);
  // Attacker takes a validly signed card and rebinds it to another request.
  const tampered = { ...card, joinRequest: { ...card.joinRequest, requestId: randomUUID() } };
  const res = await postJoin(request, tampered);
  assert.equal(res.status, 401);
});

test("a stale joinRequest is rejected", async t => {
  const { request } = await serve(t);
  const { card } = signedCard(ROOM, { issuedAt: Date.now() - 11 * 60 * 1000 });
  const res = await postJoin(request, card);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "stale_card");
});

test("the same card key renews one seat instead of taking another", async t => {
  const { request, store } = await serve(t);
  const { card, keyPair } = signedCard(ROOM);
  const first = await postJoin(request, card);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  // Second request, fresh joinRequest, same key (name may even differ — the seat is key-bound).
  const { card: card2 } = signedCard(ROOM, { keyPair });
  const second = await postJoin(request, card2);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.renewed, true);
  assert.equal(secondBody.member.id, firstBody.member.id, "same seat");
  assert.notEqual(secondBody.token, firstBody.token, "fresh credential");
  const members = Object.values(store.room(ROOM).state.members).filter(m => isGuestAgentMemberId(m.id));
  assert.equal(members.length, 1);
  // The old credential was revoked when the fresh one minted.
  const oldHash = createHash("sha256").update(firstBody.token).digest("hex");
  assert.equal(store.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(oldHash).revoked, 1);
});

test("a bad signature does not burn the key's rate quota", async t => {
  const { request, store } = await serve(t);
  store.guestInvites.selfServeKeyLimiter = createRateLimiter({ capacity: 1, refillPerSecond: 1 / 86400 });
  const { card } = signedCard(ROOM);
  // Attacker replays the victim's public key with a broken signature.
  const forged = { ...card, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  const bad = await postJoin(request, forged);
  assert.equal(bad.status, 401);
  // The victim's own valid request still goes through: the 401 never
  // reached the per-key gate.
  const good = await postJoin(request, card);
  assert.equal(good.status, 201);
});

test("per-key rate limit holds", async t => {
  const { request, store } = await serve(t);
  store.guestInvites.selfServeKeyLimiter = createRateLimiter({ capacity: 2, refillPerSecond: 2 / 86400 });
  const { card, keyPair } = signedCard(ROOM);
  assert.equal((await postJoin(request, card)).status, 201);
  const { card: card2 } = signedCard(ROOM, { keyPair });
  assert.equal((await postJoin(request, card2)).status, 200);
  const { card: card3 } = signedCard(ROOM, { keyPair });
  const limited = await postJoin(request, card3);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
});

test("self-serve guests can chat but cannot propose work", async t => {
  const { request } = await serve(t);
  const { card } = signedCard(ROOM);
  const guestToken = (await (await postJoin(request, card)).json()).token;
  // Plain chat post works (observer tier).
  const chat = await request(`/api/rooms/${ROOM}/commands`, {
    method: "POST", token: guestToken,
    data: { id: randomUUID(), type: "message.posted", data: { body: "hello from outside" } },
  });
  assert.equal(chat.status, 201);
  // A draft (work proposal) is refused: guests never leave observer without owner action.
  const draft = await request(`/api/rooms/${ROOM}/commands`, {
    method: "POST", token: guestToken,
    data: { id: randomUUID(), type: "message.posted", data: { body: "draft", workItemId: "work-1" } },
  });
  assert.equal(draft.status, 403);
  assert.equal((await draft.json()).error.code, "guest_scope_denied");
});

test("a disconnected guest can rejoin, repeatedly", async t => {
  const { request, store, advance } = await serve(t);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const { card, keyPair } = signedCard(ROOM);
  const first = await postJoin(request, card);
  assert.equal(first.status, 201);
  const memberId = (await first.json()).member.id;
  for (let round = 0; round < 2; round++) {
    advance(1000); // the disconnect event id binds the clock; time passes between rounds
    const cut = await request(`/api/rooms/${ROOM}/guest-invites-disconnect`, {
      method: "POST", token: ownerKey, data: { memberId },
    });
    assert.equal(cut.status, 200);
    assert.equal(store.room(ROOM).state.members[memberId].active, false);
    // Same key, fresh joinRequest: the seat reactivates instead of dying.
    const { card: again } = signedCard(ROOM, { keyPair });
    const rejoined = await postJoin(request, again);
    assert.equal(rejoined.status, 200);
    const body = await rejoined.json();
    assert.equal(body.renewed, true);
    assert.equal(body.member.id, memberId);
    assert.equal(store.room(ROOM).state.members[memberId].active, true);
  }
});

test("a joinRequest for an unknown room is 404", async t => {
  const { request } = await serve(t);
  const { card } = signedCard("nope-not-a-room");
  const res = await postJoin(request, card);
  assert.equal(res.status, 404);
});

test("a request without a card is 422", async t => {
  const { request } = await serve(t);
  const res = await request("/api/guest-invites/request", { method: "POST", data: {} });
  assert.equal(res.status, 422);
});

test("an identical requestId replays the original credential without rotation or quota burn", async t => {
  const { request, store } = await serve(t);
  store.guestInvites.selfServeKeyLimiter = createRateLimiter({ capacity: 2, refillPerSecond: 2 / 86400 });
  const requestId = randomUUID();
  const { card, keyPair } = signedCard(ROOM, { requestId });
  const first = await postJoin(request, card);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  // Identical retry: the exact same signed card bytes.
  const replay = await postJoin(request, card);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.token, firstBody.token, "same credential, no rotation");
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.renewed, false);
  assert.equal(replayBody.member.id, firstBody.member.id);
  assert.equal(replayBody.expiresAt, firstBody.expiresAt);
  // No rotation happened: exactly one live credential for the seat.
  const creds = store.db.prepare("SELECT revoked FROM credentials WHERE member_id=? AND kind='access'").all(firstBody.member.id);
  assert.equal(creds.length, 1);
  assert.equal(creds[0].revoked, 0);
  // The replay consumed no key quota: the two units cover the first join
  // and one renewal, and the third new requestId is rate-limited.
  const { card: card2 } = signedCard(ROOM, { keyPair, requestId: randomUUID() });
  const renewed = await postJoin(request, card2);
  assert.equal(renewed.status, 200);
  assert.notEqual((await renewed.json()).token, firstBody.token, "new requestId rotates");
  const { card: card3 } = signedCard(ROOM, { keyPair, requestId: randomUUID() });
  assert.equal((await postJoin(request, card3)).status, 429);
});

test("a superseded requestId does not resurrect a rotated credential", async t => {
  const { request, store } = await serve(t);
  const idA = randomUUID();
  const { card: cardA, keyPair } = signedCard(ROOM, { requestId: idA });
  const tokenA = (await (await postJoin(request, cardA)).json()).token;
  // A new requestId rotates: tokenA is revoked.
  const { card: cardB } = signedCard(ROOM, { keyPair, requestId: randomUUID() });
  const tokenB = (await (await postJoin(request, cardB)).json()).token;
  assert.notEqual(tokenB, tokenA);
  const hashA = createHash("sha256").update(tokenA).digest("hex");
  assert.equal(store.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(hashA).revoked, 1);
  // Replaying the OLD requestId must not hand back the dead token: the
  // stale idempotency record is dropped and the request renews instead.
  const replay = await postJoin(request, cardA);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.notEqual(replayBody.token, tokenA, "the revoked credential is never resurrected");
  assert.ok(!replayBody.replayed, "treated as a fresh renewal, not a replay");
  assert.equal(replayBody.renewed, true);
});

test("the 500-seat cap evicts the least-recently-active guest", async t => {
  const { request, store, advance } = await serve(t);
  // Two real self-serve guests; the first is the least-recently-active.
  const { card: cardOld } = signedCard(ROOM);
  const oldBody = await (await postJoin(request, cardOld)).json();
  advance(1000);
  const { card: cardNew } = signedCard(ROOM);
  const newBody = await (await postJoin(request, cardNew)).json();
  // Fill the seat table to the cap with synthetic rows strictly newer than
  // both real guests, so the LRU victim is unambiguous.
  const db = store.db;
  const future = Date.now() + 3600_000;
  const insert = db.prepare("INSERT INTO guest_selfserve(member_id, room_id, key_hash, created_at, last_active_at) VALUES(?,?,?,?,?)");
  for (let i = 0; i < GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM - 2; i++) {
    insert.run(`guest-agent-fake-${i}`, ROOM, createHash("sha256").update(`fake-${i}`).digest("hex"), future, future);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM guest_selfserve WHERE room_id=?").get(ROOM).n, GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM);
  // One more guest: the cap is hit, so the LRU seat is evicted to make room.
  const { card: cardThird } = signedCard(ROOM);
  const res = await postJoin(request, cardThird);
  assert.equal(res.status, 201);
  const thirdBody = await res.json();
  assert.notEqual(thirdBody.member.id, oldBody.member.id);
  const victim = store.room(ROOM).state.members[oldBody.member.id];
  assert.equal(victim.active, false, "evicted member deactivated");
  const victimCreds = db.prepare("SELECT revoked FROM credentials WHERE room_id=? AND member_id=?").all(ROOM, oldBody.member.id);
  assert.ok(victimCreds.length > 0 && victimCreds.every(r => r.revoked === 1), "evicted credentials revoked");
  assert.equal(db.prepare("SELECT 1 FROM guest_selfserve WHERE member_id=?").get(oldBody.member.id), undefined, "victim seat row dropped");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM guest_selfserve WHERE room_id=?").get(ROOM).n, GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM, "cap holds");
  // The more-recently-active guest survives the eviction.
  assert.equal(store.room(ROOM).state.members[newBody.member.id].active, true);
});

test("panic revoke immediately invalidates a self-serve guest credential", async t => {
  const { request, store } = await serve(t);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const { card } = signedCard(ROOM);
  const joined = await (await postJoin(request, card)).json();
  const guestToken = joined.token;
  const memberId = joined.member.id;
  // The pass works before the panic switch.
  const chat = (body) => request(`/api/rooms/${ROOM}/commands`, {
    method: "POST", token: guestToken,
    data: { id: randomUUID(), type: "message.posted", data: { body } },
  });
  assert.equal((await chat("hello")).status, 201);
  // Owner hits the panic switch.
  const panic = await request(`/api/rooms/${ROOM}/guest-invites-revoke-all`, { method: "POST", token: ownerKey });
  assert.equal(panic.status, 200);
  assert.equal((await panic.json()).revoked, 1);
  // The member is deactivated and the credential row is revoked.
  assert.equal(store.room(ROOM).state.members[memberId].active, false);
  const tokenHash = createHash("sha256").update(guestToken).digest("hex");
  assert.equal(store.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(tokenHash).revoked, 1);
  // The credential is dead immediately: the same chat post is now refused.
  const after = await chat("hello again");
  assert.equal(after.status, 401);
  assert.equal((await after.json()).error.code, "unauthenticated");
});
