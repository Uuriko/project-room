// Regression: a lost rotation response or a lost join 201 strands the agent.
// R306: rotate() swaps the hash with no receipt, so a client whose 200 was
// lost holds a retired secret and can never recover the replacement; the
// retry answers 401 "Unknown agent identity" forever. The fix journals a
// rotation receipt keyed to requestId, and a same-requestId retry that
// presents the pre-rotation secret re-rotates inside a short TTL.
// R305-1: the idempotent redeem replay (G1) returns duplicate:true and a
// room token but never an identity secret, and its next[] claims a durable
// credential was presented when none was. A credential-less replay now
// rotates a fresh secret and shows it in that response.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "commons";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-rotation-receipts-"));
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
  return { store, request, ownerKey, advance: ms => { clock += ms; } };
}

test("a lost rotation response recovers through the requestId receipt", async t => {
  const { request, advance } = await serve(t);
  const minted = await request("/api/agent-identities", { method: "POST", data: { displayName: "Receipt Probe" } });
  assert.equal(minted.status, 201);
  const { identityId, secret } = await minted.json();
  const requestId = randomUUID();

  const first = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(first.status, 200);
  const landed = await first.json();
  assert.ok(landed.secret, "the first rotation shows the replacement once");

  // The response was lost: the client still holds the ORIGINAL secret and
  // retries with the same requestId. The receipt re-rotates.
  const retry = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(retry.status, 200, "a same-requestId retry with the pre-rotation secret re-rotates instead of 401");
  const replayed = await retry.json();
  assert.equal(replayed.duplicate, true);
  assert.ok(replayed.secret, "the retry shows a fresh replacement");
  assert.notEqual(replayed.secret, landed.secret);
  assert.notEqual(replayed.secret, secret);

  // The old secret authenticates nothing else after the retry rotation,
  // and the lost replacement is dead too: both must fail identity-wide.
  const oldDead = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true },
  });
  assert.equal(oldDead.status, 401);
  const lostReplacement = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: landed.secret, data: { confirm: true },
  });
  assert.equal(lostReplacement.status, 401, "the never-received replacement from the lost response is retired");

  // The fresh secret from the retry authenticates: a plain rotate with it
  // must succeed (no requestId, so it is an ordinary rotation).
  const live = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: replayed.secret, data: { confirm: true },
  });
  assert.equal(live.status, 200);

  // A retry with the wrong requestId is not the receipt holder.
  const wrongId = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId: randomUUID() },
  });
  assert.equal(wrongId.status, 401);

  // Past the TTL the receipt is gone and the old secret is dead for good.
  advance(11 * 60 * 1000);
  const expired = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(expired.status, 401);
});

test("a credential-less join replay issues a fresh durable secret", async t => {
  const { request, ownerKey } = await serve(t);
  const inv = await request(`/api/rooms/${ROOM}/agent-invites`, {
    method: "POST", token: ownerKey, data: { permissions: ["accept_work"] },
  });
  assert.equal(inv.status, 201);
  const code = (await inv.json())?.code;
  assert.ok(code);
  const requestId = randomUUID();
  const joinBody = { displayName: "Lost 201 Probe", inviteCode: code, requestId };

  const first = await request("/api/join", { method: "POST", data: joinBody });
  assert.equal(first.status, 201);
  const minted = await first.json();
  assert.ok(minted.identitySecret, "the first join shows the secret once");

  // The 201 was lost: the retry presents nothing and replays the receipt.
  const retry = await request("/api/join", { method: "POST", data: joinBody });
  assert.equal(retry.status, 201, "the requestId replay still replays the membership");
  const replayed = await retry.json();
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.memberId, minted.memberId ?? minted.member?.id);
  assert.ok(replayed.identitySecret, "the credential-less replay shows a fresh identity secret instead of stranding the seat");
  assert.notEqual(replayed.identitySecret, minted.identitySecret);
  assert.ok(JSON.stringify(replayed.next).includes("Save identitySecret now"),
    "next[] says a fresh secret was issued in this response");

  // The fresh secret authenticates: a plain rotate with it must succeed.
  // That rotate retires the replay's secret, so the replacement it shows
  // is what the later Bearer replay presents.
  const identityId = replayed.identityId;
  const live = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: replayed.identitySecret, data: { confirm: true },
  });
  assert.equal(live.status, 200);
  const liveSecret = (await live.json()).secret;
  assert.ok(liveSecret);

  // A replay that presents its CURRENT credential keeps today's shape.
  const bearerRetry = await request("/api/join", {
    method: "POST", token: liveSecret, data: joinBody,
  });
  assert.equal(bearerRetry.status, 201);
  const presented = await bearerRetry.json();
  assert.equal(presented.duplicate, true);
  assert.equal("secret" in presented, false, "a Bearer-presenting replay does not mint a new secret");

  // The old secret was retired by the credential-less replay's rotation.
  const oldAfter = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: minted.identitySecret, data: { confirm: true },
  });
  assert.equal(oldAfter.status, 401, "the secret from the lost 201 is retired");
});

// v3 hardening (landing-lane blockers at 13518): the receipt path must
// require the same explicit confirm and exact shape as an ordinary rotation,
// and a receipt dies the moment a later ordinary rotation, revoke, or
// redemption replay rotates the secret again.
test("a receipt retry requires the same explicit confirm as an ordinary rotation", async t => {
  const { request } = await serve(t);
  const minted = await request("/api/agent-identities", { method: "POST", data: { displayName: "Confirm Gate Probe" } });
  assert.equal(minted.status, 201);
  const { identityId, secret } = await minted.json();
  const requestId = randomUUID();
  const first = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(first.status, 200);
  const landed = await first.json();

  // The lost-response client retries but forgets confirm:true: the
  // malformed request must skip the receipt consult entirely, so it cannot
  // rotate, and it reaches the owner check first (401, not the shape
  // guidance) because the presented credential is retired.
  const bare = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { requestId },
  });
  assert.equal(bare.status, 401, "a receipt retry without confirm:true must not rotate");
  // An exact-shape violation (a stray extra field) skips the consult too.
  const stray = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId, note: "hi" },
  });
  assert.equal(stray.status, 401, "a receipt retry with fields outside the shape must not rotate");
  // The current holder sending a malformed receipt-shaped request still
  // gets the shape guidance, and it must not consume the receipt either.
  const liveBare = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: landed.secret, data: { requestId },
  });
  assert.equal(liveBare.status, 422, "a live holder without confirm:true gets the shape guidance");
  const stillRecoverable = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(stillRecoverable.status, 200, "a well-formed retry still recovers through the receipt");
  // The retry rotated again, so the first response's replacement is now
  // retired and only the retry's fresh secret is live.
  const freshSecret = (await stillRecoverable.json()).secret;
  const retiredFirst = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: landed.secret, data: { confirm: true },
  });
  assert.equal(retiredFirst.status, 401, "the replacement from the first lost response is retired by the retry");
  const live = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: freshSecret, data: { confirm: true },
  });
  assert.equal(live.status, 200, "the identity stays live through the malformed attempts");
});

test("an ordinary rotation or a revoke invalidates the receipt", async t => {
  const { request } = await serve(t);
  const minted = await request("/api/agent-identities", { method: "POST", data: { displayName: "Receipt Expiry Probe" } });
  assert.equal(minted.status, 201);
  const { identityId, secret } = await minted.json();
  const requestId = randomUUID();
  const first = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(first.status, 200);
  const landed = await first.json();

  // A later ORDINARY rotation (the holder got the replacement after all)
  // must retire the receipt: the old credential must not re-rotate after
  // the secret has moved on again.
  const later = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: landed.secret, data: { confirm: true },
  });
  assert.equal(later.status, 200);
  const stale = await request(`/api/agent-identities/${identityId}/rotate`, {
    method: "POST", token: secret, data: { confirm: true, requestId },
  });
  assert.equal(stale.status, 401, "a receipt must not survive a later ordinary rotation");

  // Same for revoke: final state, the receipt dies with it.
  const minted2 = await request("/api/agent-identities", { method: "POST", data: { displayName: "Receipt Revoke Probe" } });
  assert.equal(minted2.status, 201);
  const { identityId: id2, secret: sec2 } = await minted2.json();
  const req2 = randomUUID();
  const first2 = await request(`/api/agent-identities/${id2}/rotate`, {
    method: "POST", token: sec2, data: { confirm: true, requestId: req2 },
  });
  assert.equal(first2.status, 200);
  const landed2 = await first2.json();
  const revoked = await request(`/api/agent-identities/${id2}/revoke`, {
    method: "POST", token: landed2.secret, data: { confirm: true },
  });
  assert.equal(revoked.status, 200);
  const after = await request(`/api/agent-identities/${id2}/rotate`, {
    method: "POST", token: sec2, data: { confirm: true, requestId: req2 },
  });
  assert.equal(after.status, 401, "a receipt must not survive a revoke");
});
