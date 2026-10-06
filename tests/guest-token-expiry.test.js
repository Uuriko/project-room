// Real guest-token expiry lifecycle (wave-2 QA gap).
//
// Guest-agent links (ga1. bearer credentials, fixed 2h TTL) are already
// covered for the coarse case: guest-agent-links.test.js asserts expiry stops
// the credential after TTL+1ms, and guest-agent-refresh.test.mjs covers the
// self-service refresh path. This file owns the precision contracts neither
// file reaches:
//
//  1. The token dies EXACTLY at its expiry instant. The validation is a
//     strict `expires_at > now()` (guest-agent-links liveCredential) and
//     `expires_at <= now()` rejects (store.authenticate): there is no clock
//     skew tolerance or grace leeway anywhere in the product. The token must
//     work at expires_at - 1ms and be rejected at expires_at.
//  2. A bearer in active use over real HTTP is cut off at expiry: the full
//     mint -> use -> expire -> reject path on the transport boundary, with
//     the exact error shape the client sees.
//  3. An expired token is never revived into validity: once the owner sweep
//     ends the seat, re-minting the same requestId is rejected and the old
//     bearer stays rejected on every validation path.
//
// Credible regressions these catch: widening the boundary to `>=` or adding a
// skew leeway (test 1); dropping the expires_at check from the HTTP auth path
// while keeping it in preview/join (test 2); resurrecting swept members on
// re-mint (test 3).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { GUEST_AGENT_TOKEN_PREFIX, GUEST_AGENT_TTL_MS } from "../server/guest-agent-links.mjs";

const guestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-token-expiry-"));
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
  return { store, request, ownerKey, advance: ms => { clock += ms; }, now: () => clock };
}

const mint = (request, ownerKey, extras = {}) => request("/api/rooms/commons/guest-agent-links", {
  method: "POST", token: ownerKey,
  data: { requestId: randomUUID(), expectedOwnerRevision: 0, ...extras },
});
const preview = (request, linkToken) =>
  request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken } });
const joinLink = (request, linkToken) =>
  request("/api/guest-agent-links/join", { method: "POST", data: { linkToken } });

test("guest token dies exactly at its expiry instant: no grace, no skew", async t => {
  const { store, request, ownerKey, advance, now } = await serve(t);
  const mintedRes = await mint(request, ownerKey, { linkToken: guestToken() });
  assert.equal(mintedRes.status, 201);
  const minted = await mintedRes.json();
  const token = minted.token;
  const expiresAt = minted.expiresAt;
  assert.ok(expiresAt > now(), "minted with a live TTL");

  // One millisecond before the instant: every validation path accepts it.
  // (Simulates the short remaining-TTL window the task asks for.)
  advance(expiresAt - now() - 1);
  assert.equal(now(), expiresAt - 1);
  assert.equal((await preview(request, token)).status, 200);
  assert.equal((await joinLink(request, token)).status, 200);
  assert.equal(store.authenticate(token, "commons", null).member.id, minted.member.id);
  assert.equal((await request("/api/rooms/commons", { token })).status, 200);

  // Exactly at the instant: the strict expires_at > now() boundary rejects.
  advance(1);
  assert.equal(now(), expiresAt);
  const expiredPreview = await preview(request, token);
  assert.equal(expiredPreview.status, 410);
  assert.equal((await expiredPreview.json()).error.code, "link_unavailable");
  const expiredJoin = await joinLink(request, token);
  assert.equal(expiredJoin.status, 410);
  assert.equal((await expiredJoin.json()).error.code, "link_unavailable");
  assert.throws(() => store.authenticate(token, "commons", null), { status: 401, code: "unauthenticated" });

  // One millisecond past the instant: still dead. No leeway anywhere.
  advance(1);
  assert.throws(() => store.authenticate(token, "commons", null), { status: 401, code: "unauthenticated" });
  assert.equal((await preview(request, token)).status, 410);
});

test("a bearer in active use over HTTP is cut off at expiry with 401", async t => {
  const { request, ownerKey, advance } = await serve(t);
  const mintedRes = await mint(request, ownerKey);
  assert.equal(mintedRes.status, 201);
  const token = (await mintedRes.json()).token;

  // Real use: the guest reads the room over the authenticated HTTP path.
  const before = await request("/api/rooms/commons", { token });
  assert.equal(before.status, 200);
  assert.ok((await before.json()).state, "snapshot readable while live");

  advance(GUEST_AGENT_TTL_MS + 1);

  // Same request after expiry: rejected on the transport boundary with the
  // exact error a client must handle.
  const after = await request("/api/rooms/commons", { token });
  assert.equal(after.status, 401);
  const body = await after.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(body.reason, "unauthenticated");
});

test("an expired token is never revived: re-mint on the same requestId is rejected, the old bearer stays dead", async t => {
  const { store, request, ownerKey, advance } = await serve(t);
  const requestId = randomUUID();
  const first = await mint(request, ownerKey, { requestId, linkToken: guestToken() });
  assert.equal(first.status, 201);
  const minted = await first.json();
  const token = minted.token;
  assert.equal((await preview(request, token)).status, 200);

  advance(GUEST_AGENT_TTL_MS + 1);

  // A fresh owner mint runs the expiry sweep and ends the expired member.
  const second = await mint(request, ownerKey);
  assert.equal(second.status, 201);
  assert.equal(store.room("commons").state.members[minted.member.id].active, false);

  // The expired seat cannot be resurrected on its requestId: no new token is
  // issued for it, and the old bearer stays rejected on every validation
  // path. Only a fresh owner mint (new requestId) or the dedicated
  // possession-proof /refresh endpoint can create a new credential — the
  // expired bearer itself never becomes valid again.
  const retry = await mint(request, ownerKey, { requestId });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).error.code, "membership_ended");
  assert.equal((await preview(request, token)).status, 410);
  assert.equal((await joinLink(request, token)).status, 410);
  assert.throws(() => store.authenticate(token, "commons", null), { status: 401, code: "unauthenticated" });
  const row = store.db.prepare("SELECT revoked, expires_at FROM credentials WHERE hash=?").get(sha256(token));
  assert.ok(row.expires_at <= store.now(), "credential row still expired");
});
