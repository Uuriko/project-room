// Contract fixtures for RC-2026-09-25-912 self-serve join (guest-agent-links v2).
// Activation condition: un-skip both tests when the RC-912 self-serve-join route lands.
// FIXTURES FIRST: written against docs/self-serve-join.md (branch
// jill/self-serve-join-912) before the build lands. These tests are EXPECTED
// TO FAIL until the v2 route ships - that is the point: the build is done when
// these pass. Scope: the two durability guarantees the doc makes that map to
// known incident classes, not the whole contract.
//
//   1. Identity durability (#770 class): the same card key re-joining after
//      its pass expired returns the SAME memberId, holds ONE slot, and its
//      history is intact - never a duplicate guest member.
//   2. requestId idempotency: an identical retry (client lost the response)
//      returns the SAME credential, not a second pass.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-selfserve-"));
  const clock = { now: Date.parse("2026-09-25T12:00:00.000Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin, clock };
}

// Minimal Ed25519-signed agent card, matching the doc's contract: the server
// verifies the signature against the card's own public key (self-attested).
function agentCard(name) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const payload = JSON.stringify({ name, publicKey: publicKeyPem });
  const signature = cryptoSign(null, Buffer.from(payload), privateKey).toString("base64");
  return { name, publicKey: publicKeyPem, signature };
}

const requestJoin = (origin, body) => fetch(origin + "/api/guest-agent-links/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
}).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }));

test.skip("fixture 1: identity durability - same card key re-joins after expiry to the same memberId, one slot, history intact", async t => {
  const { store, origin, clock } = await setup(t);
  const card = agentCard("durability-agent");
  const first = await requestJoin(origin, { displayName: "Durability Agent", agentCard: card, requestId: "req-durability-1" });
  assert.equal(first.status, 200, "initial self-serve join is accepted");
  const firstMemberId = first.body.memberId;
  assert.match(firstMemberId, /^guest-agent-/, "guest memberId is badged by shape");

  // The guest leaves history behind while its first pass is live. The issued
  // credential is the member's bearer key (v0 ga1. shape), so it commands
  // as that member.
  const posted = store.command(first.body.credential, "commons", {
    id: "durability-msg-1", type: "message.posted",
    data: { messageId: "durability-m1", body: "hello from the first pass" }
  });
  assert.equal(posted.duplicate, false);

  // The pass expires: advance past the documented 24h TTL.
  clock.now += 25 * 60 * 60 * 1000;

  const second = await requestJoin(origin, { displayName: "Durability Agent", agentCard: card, requestId: "req-durability-2" });
  assert.equal(second.status, 200, "re-join after expiry is a renewal, not an error");
  assert.equal(second.body.memberId, firstMemberId, "#770 class: same card key must keep the same memberId");

  const guests = store.db.prepare("SELECT id FROM members WHERE room_id='commons' AND id LIKE 'guest-agent-%'").all();
  assert.equal(guests.length, 1, "one live slot per key, not a duplicate guest member");

  // History survives the expiry: the first pass's message is still there and
  // still attributed to the SAME member, not to a tombstoned duplicate.
  const history = store.db.prepare("SELECT json_extract(body,'$.actorId') AS actorId, body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')='durability-m1'").all();
  assert.equal(history.length, 1, "the first pass's message survives the expiry");
  assert.equal(history[0].actorId, firstMemberId, "history stays attributed to the durable memberId");
});

test.skip("fixture 2: requestId idempotency - identical retry returns the same credential", async t => {
  const { origin } = await setup(t);
  const card = agentCard("idempotent-agent");
  const body = { displayName: "Idempotent Agent", agentCard: card, requestId: "req-idem-1" };
  const first = await requestJoin(origin, body);
  assert.equal(first.status, 200);
  assert.ok(first.body.credential?.startsWith("ga1."), "credential keeps the ga1. shape from v0");

  const retry = await requestJoin(origin, body);
  assert.equal(retry.status, 200, "a retry is not 409 already_joined - it is the same request");
  assert.equal(retry.body.credential, first.body.credential, "same requestId returns the same credential");
  assert.equal(retry.body.memberId, first.body.memberId);
});
