// Regression: GuestInvites#sweepExpiredGuests judged a seat by an arbitrary
// credentials row (no revoked filter, no ORDER BY). A guest holds several
// rows over its life — rotation revokes the old row and inserts a fresh
// live one — so the sweep could read the revoked predecessor, conclude the
// seat was dead, and deactivate a guest whose current credential is live
// (deactivation revokes ALL of the member's credentials, the live one
// included). The sweep must judge the seat by an unrevoked row, like
// GuestAgentLinks#sweepExpired does.
//
// Trigger: any later redeem in the same room runs the sweep first.
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

const ROOM = "commons";
const ONE_HOUR = 3600 * 1000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-sweep-rotated-"));
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

async function mintInvite(request, ownerKey, extras = {}) {
  const res = await request(`/api/rooms/${ROOM}/guest-invites`, {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "sweep probe", expectedOwnerRevision: 0, ...extras },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function redeemGuest(request, store, code, name) {
  const identity = store.identities.create(`${name}-${randomUUID().slice(0, 6)}`);
  const keys = generateKeyPair();
  const cardBody = { name, description: "sweep probe", capabilities: ["chat"] };
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

test("the expiry sweep keeps a rotated guest whose current credential is live", async t => {
  const { store, request, ownerKey } = await serve(t);
  const invited = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invited.code, "Rotated");
  const memberId = guest.member.id;

  // Rotate: the old credential row is revoked and a fresh live row is
  // inserted for the same member — two rows, the first one revoked.
  const rotated = await request("/api/guest-invites/rotate", {
    method: "POST", token: guest.token, data: { roomId: ROOM },
  });
  assert.equal(rotated.status, 200);
  const { token: rotatedToken } = await rotated.json();
  assert.equal((await postChat(request, rotatedToken, "rotated and live")).status, 201);

  // A second guest redeeming runs sweepExpiredGuests over the room first.
  const invited2 = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  await redeemGuest(request, store, invited2.code, "Trigger");

  assert.equal(store.room(ROOM).state.members[memberId].active, true,
    "the sweep must not deactivate a guest whose live credential was rotated in");
  const still = await postChat(request, rotatedToken, "still here after the sweep");
  assert.equal(still.status, 201, "the rotated credential survives the sweep");
});

test("the expiry sweep still deactivates a guest whose only credential expired", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  const invited = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invited.code, "Doomed");
  const memberId = guest.member.id;

  advance(ONE_HOUR + 1000);
  const invited2 = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  await redeemGuest(request, store, invited2.code, "Trigger");

  assert.equal(store.room(ROOM).state.members[memberId].active, false,
    "a guest with no live credential is still swept");
  assert.equal((await postChat(request, guest.token, "expired")).status, 401);
});
