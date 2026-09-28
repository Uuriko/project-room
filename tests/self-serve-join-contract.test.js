// Contract fixtures for RC-2026-09-25-912 self-serve join.
// Updated for post-#1078 (Burs-IA) replay behavior: an identical requestId
// replay returns member/status metadata with replayed:true and NEVER the
// Bearer credential again.
//
// Scope: the two durability guarantees the contract makes that map to known
// incident classes:
//   1. Identity durability (#770 class): the same card key re-joining after
//      its pass expired returns the SAME memberId, holds ONE slot, and its
//      history is intact - never a duplicate guest member.
//   2. requestId idempotency (post-#1078): an identical retry returns
//      replayed:true with the same member/status metadata but NO credential.
//      The client must persist the token from the first response.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { isGuestAgentMemberId } from "../server/guest-agent-links.mjs";

const ROOM = "commons";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-selfserve-contract-"));
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
  return { store, request, advance: ms => { clock += ms; }, now: () => clock };
}

// A self-signed agent card carrying a joinRequest, signed the way an
// outside agent would: signCard over the card body (joinRequest included).
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

test("fixture 1: identity durability - same card key re-joins after expiry to the same memberId, one slot, history intact", async t => {
  const { store, request, advance, now } = await serve(t);
  const requestId1 = randomUUID();
  const { card, keyPair } = signedCard(ROOM, { name: "Durability Agent", requestId: requestId1 });
  const first = await postJoin(request, card);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.ok(firstBody.token, "first join issues a Bearer credential");
  const firstMemberId = firstBody.member.id;
  assert.ok(isGuestAgentMemberId(firstMemberId), "guest memberId is badged by shape");

  // The guest leaves history behind while its first pass is live.
  const posted = await request(`/api/rooms/${ROOM}/commands`, {
    method: "POST",
    token: firstBody.token,
    data: { id: "durability-msg-1", type: "message.posted", data: { messageId: "durability-m1", body: "hello from the first pass" } }
  });
  assert.equal(posted.status, 201, "guest can post with its credential");

  // The pass expires: advance past the 24h TTL.
  advance(25 * 60 * 60 * 1000);

  // Re-join with the SAME key but a NEW requestId (fresh joinRequest).
  // Note: issuedAt must use the advanced clock, not real time.
  const { card: card2 } = signedCard(ROOM, { name: "Durability Agent", keyPair, requestId: randomUUID(), agentId: card.agentId, issuedAt: now() });
  const second = await postJoin(request, card2);
  assert.ok([200, 201].includes(second.status), "re-join after expiry succeeds (200 renewal or 201 new)");
  const secondBody = await second.json();
  assert.equal(secondBody.member.id, firstMemberId, "#770 class: same card key must keep the same memberId");

  const guests = Object.values(store.room(ROOM).state.members).filter(m => isGuestAgentMemberId(m.id));
  assert.equal(guests.length, 1, "one live slot per key, not a duplicate guest member");

  // History survives the expiry: the first pass's message is still there and
  // still attributed to the SAME member, not to a tombstoned duplicate.
  const history = store.db.prepare("SELECT json_extract(body,'$.actorId') AS actorId FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')='durability-m1'").all(ROOM);
  assert.equal(history.length, 1, "the first pass's message survives the expiry");
  assert.equal(history[0].actorId, firstMemberId, "history stays attributed to the durable memberId");
});

test("fixture 2: requestId idempotency (post-#1078) - identical retry returns replayed:true with NO credential", async t => {
  const { request } = await serve(t);
  const requestId = randomUUID();
  const { card } = signedCard(ROOM, { name: "Idempotent Agent", requestId });
  const first = await postJoin(request, card);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.ok(firstBody.token, "first join issues a Bearer credential");

  // Identical retry: the exact same signed card bytes. Post-#1078, the replay
  // must NOT return the credential — a captured request body must not be
  // sufficient to recover the live token (Burs-IA review).
  const retry = await postJoin(request, card);
  assert.equal(retry.status, 200, "a retry is 200, not 409");
  const retryBody = await retry.json();
  assert.equal(retryBody.replayed, true, "replay is flagged");
  assert.equal(retryBody.token, undefined, "replay never discloses the Bearer credential");
  assert.equal(retryBody.member.id, firstBody.member.id, "same member");
  assert.equal(retryBody.expiresAt, firstBody.expiresAt, "same expiry");
});
