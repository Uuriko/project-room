// Self-service refresh for expired v0 guest-agent credentials (issue #1563).
//
// v0 (server/guest-agent-links.mjs) minted owner-issued ga1. tokens with a
// fixed 2h TTL and no refresh path: once expired, the only recovery was a
// fresh owner mint. POST /api/guest-agent-links/refresh lets the holder of
// an EXPIRED v0 credential mint a fresh one for the same seat, no owner
// round-trip. Possession of the expired token is the proof: it is a 256-bit
// secret only the holder ever saw.
//
// Contracts guarded here:
//  1. expired v0 credential -> fresh live credential, same member, no owner.
//  2. the pre-refresh credential stays dead (revoked; never authenticates).
//  3. forged / malformed refresh requests are rejected.
//  4. a revoked credential can never be refreshed (owner revocation is final).
//  5. a still-live credential is not refreshable (409; use rotate for leaks).
//  6. v1 guest-invite seats stay owner-mediated (the credential TTL is the
//     owner's leash; self-refresh would let the guest extend it unilaterally).
//  7. a swept (owner-ended) membership is not resurrected by refresh.
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
import {
  GUEST_AGENT_TOKEN_PREFIX, GUEST_AGENT_TTL_MS,
} from "../server/guest-agent-links.mjs";

const guestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-refresh-"));
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
  return { store, origin, request, ownerKey, advance: ms => { clock += ms; }, now: () => clock };
}

async function mintV0(request, ownerKey) {
  const res = await request("/api/rooms/commons/guest-agent-links", {
    method: "POST", token: ownerKey, data: { requestId: randomUUID(), expectedOwnerRevision: 0 },
  });
  assert.equal(res.status, 201);
  return res.json();
}

const refresh = (request, linkToken) =>
  request("/api/guest-agent-links/refresh", { method: "POST", data: { linkToken } });

const preview = (request, linkToken) =>
  request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken } });

test("expired v0 credential refreshes to a live credential with no owner round-trip", async t => {
  const { store, request, ownerKey, advance, now } = await serve(t);
  const minted = await mintV0(request, ownerKey);
  const oldToken = minted.token;
  const memberId = minted.member.id;

  // Sanity: the credential is live before expiry.
  assert.equal((await preview(request, oldToken)).status, 200);

  advance(GUEST_AGENT_TTL_MS + 1000);
  assert.equal((await preview(request, oldToken)).status, 410);

  // No owner credential anywhere in this call: pure possession of the
  // expired token.
  const res = await refresh(request, oldToken);
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.ok(value.token.startsWith(GUEST_AGENT_TOKEN_PREFIX));
  assert.notEqual(value.token, oldToken);
  assert.equal(value.member.id, memberId);
  assert.equal(value.refreshed, true);
  assert.equal(value.access, "read_chat");
  assert.deepEqual(value.member.permissions, []);
  assert.equal(value.account, false);
  // Fresh fixed v0 TTL from the refresh moment, not the old expiry.
  assert.ok(Math.abs(value.expiresAt - (now() + GUEST_AGENT_TTL_MS)) < 5000);

  // The new credential authenticates: preview answers and the store
  // accepts it as a bearer.
  assert.equal((await preview(request, value.token)).status, 200);
  const auth = store.authenticate(value.token, "commons", null);
  assert.equal(auth.member.id, memberId);
});

test("the pre-refresh credential stays dead after refresh", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  const minted = await mintV0(request, ownerKey);
  advance(GUEST_AGENT_TTL_MS + 1000);
  const res = await refresh(request, minted.token);
  assert.equal(res.status, 200);

  // The old row is revoked in storage and the old bearer no longer
  // authenticates anywhere.
  const row = store.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(sha256(minted.token));
  assert.equal(row.revoked, 1);
  assert.equal((await preview(request, minted.token)).status, 410);
  assert.throws(() => store.authenticate(minted.token, "commons", null));

  // A repeat refresh of the same dead token cannot mint again: no
  // resurrection of the burned credential.
  const again = await refresh(request, minted.token);
  assert.equal(again.status, 410);
});

test("forged and malformed refresh requests are rejected", async t => {
  const { request } = await serve(t);
  // Well-shaped but never issued: unknown token.
  const forged = await refresh(request, guestToken());
  assert.equal(forged.status, 410);
  assert.equal((await forged.json()).error.code, "link_unavailable");
  // Not a token at all.
  const garbage = await refresh(request, "not-a-token");
  assert.equal(garbage.status, 410);
  // Human share-link shape is the wrong kind entirely.
  const human = await refresh(request, randomBytes(32).toString("base64url"));
  assert.equal(human.status, 422);
  assert.equal((await human.json()).error.code, "wrong_link_kind");
  // Missing field.
  const missing = await request("/api/guest-agent-links/refresh", { method: "POST", data: {} });
  assert.equal(missing.status, 422);
});

test("a revoked credential can never be refreshed", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  const minted = await mintV0(request, ownerKey);
  // Owner/admin revocation lands as revoked=1 on the credential row (the
  // delegate expiry sweep writes it this way); refresh must not bypass it.
  store.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(sha256(minted.token));
  advance(GUEST_AGENT_TTL_MS + 1000);
  const res = await refresh(request, minted.token);
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error.code, "link_unavailable");
});

test("a still-live credential is not refreshable", async t => {
  const { request, ownerKey } = await serve(t);
  const minted = await mintV0(request, ownerKey);
  const res = await refresh(request, minted.token);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "credential_still_live");
  // The live credential keeps working: refresh did not rotate or kill it.
  assert.equal((await preview(request, minted.token)).status, 200);
});

test("v1 guest-invite seats stay owner-mediated", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  // Full v1 path: owner mints a GX- code with a short 1h credential TTL,
  // the guest redeems with a signed agent card. The seat lands in
  // guest_members, which is what keeps it out of the v0 refresh path.
  const mintRes = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "v1 visit", expectedOwnerRevision: 0, credentialTtlMs: 3600 * 1000 },
  });
  assert.equal(mintRes.status, 201);
  const invite = await mintRes.json();
  const identity = store.identities.create("Synapse");
  const keys = generateKeyPair();
  const cardBody = { name: "Synapse", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: invite.code, card },
  });
  assert.equal(redeemed.status, 201);
  const v1token = (await redeemed.json()).token;
  assert.ok(v1token.startsWith(GUEST_AGENT_TOKEN_PREFIX));

  advance(3600 * 1000 + 1000);
  const res = await refresh(request, v1token);
  assert.equal(res.status, 410);
  // v1 clients already handle invite_unavailable as "ask the owner".
  assert.equal((await res.json()).error.code, "invite_unavailable");
});

test("a swept (owner-ended) membership is not resurrected by refresh", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  const minted = await mintV0(request, ownerKey);
  advance(GUEST_AGENT_TTL_MS + 1000);
  // A second owner mint runs the expiry sweep, which deactivates the
  // expired member. Refresh must not undo the owner's eject.
  await mintV0(request, ownerKey);
  assert.equal(store.room("commons").state.members[minted.member.id].active, false);
  const res = await refresh(request, minted.token);
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error.code, "membership_ended");
  assert.equal(store.room("commons").state.members[minted.member.id].active, false);
});
