// WAVE-500 guild 2: an expired GX guest invite must fail with the honest
// invite_expired error (410), not invite_unavailable ("This guest invite is
// not valid."). agent-invites and referral-invites already make this
// distinction; guest-invites lumped expired, revoked, redeemed, and
// never-issued codes into one misleading "not valid" error, so an invitee
// whose code merely lapsed gets told the code is wrong instead of stale.
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
  const directory = mkdtempSync(join(tmpdir(), "room-gx-expired-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
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
  return { store, origin, request, ownerKey, now: () => clock };
}

async function mintInvite(request, ownerKey) {
  const res = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "lapse probe", expectedOwnerRevision: 0 },
  });
  assert.equal(res.status, 201);
  return res.json();
}

function signedCard(store, name) {
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "lapse probe", capabilities: ["chat"] };
  return { identity, card: { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) } };
}

test("expired GX codes report invite_expired on preview, not invite_unavailable", async t => {
  const { store, request, ownerKey, now } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  // Forge the lapse: backdate the redeem window so the code is expired.
  store.db.prepare("UPDATE guest_invites SET created_at=?, redeem_by=? WHERE id=?").run(now() - 7200000, now() - 3600000, minted.inviteId);

  const preview = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: minted.code } });
  assert.equal(preview.status, 410);
  const body = await preview.json();
  assert.equal(body.error.code, "invite_expired");
  assert.match(body.error.message, /expired/i);
});

test("expired GX codes report invite_expired on redeem, not invite_unavailable", async t => {
  const { store, request, ownerKey, now } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  store.db.prepare("UPDATE guest_invites SET created_at=?, redeem_by=? WHERE id=?").run(now() - 7200000, now() - 3600000, minted.inviteId);

  const { identity, card } = signedCard(store, "Lapse Probe");
  const redeem = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(redeem.status, 410);
  const body = await redeem.json();
  assert.equal(body.error.code, "invite_expired");
  assert.match(body.error.message, /expired/i);
});

test("never-issued and revoked GX codes stay invite_unavailable", async t => {
  const { request, ownerKey } = await serve(t);
  const missing = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: `GX-${"x".repeat(32)}` } });
  assert.equal(missing.status, 410);
  assert.equal((await missing.json()).error.code, "invite_unavailable");

  const minted = await mintInvite(request, ownerKey);
  const revoked = await request("/api/rooms/commons/guest-invites-revoke", {
    method: "POST", token: ownerKey, data: { inviteId: minted.inviteId },
  });
  assert.equal(revoked.status, 200);
  const preview = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: minted.code } });
  assert.equal(preview.status, 410);
  assert.equal((await preview.json()).error.code, "invite_unavailable");
});
