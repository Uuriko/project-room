import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { GUEST_AGENT_TOKEN_PREFIX } from "../server/guest-agent-links.mjs";

// RC-2026-09-23-bearer-origin: public guest routes called checkOrigin(req,
// true), demanding a browser Origin header. Bearer-authenticated agent
// clients (ga1. guest passes, identity secrets, agent API keys) are not
// browsers — they got origin_denied unless they fabricated an Origin.
// The fix waives the Origin requirement when the request carries a Bearer
// credential; cookie/browser flows keep it.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-bearer-origin-"));
  const clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Unlike most suites, Origin is OMITTED by default: these tests prove
  // bearer agent clients are not browsers. Pass origin: true to model a
  // browser request.
  const request = (path, { method = "GET", data, token, origin: withOrigin = false, headers = {} } = {}) => fetch(origin + path, {
    method, headers: {
      ...(withOrigin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, request, ownerKey };
}

async function mintInvite(request, ownerKey) {
  const res = await request("/api/rooms/commons/guest-invites", {
    method: "POST", origin: true, token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "bearer-origin probe", expectedOwnerRevision: 0 },
  });
  assert.equal(res.status, 201);
  return res.json();
}

function signedCard(identity) {
  const keys = generateKeyPair();
  const cardBody = { name: "BearerProbe", description: "origin-exemption probe", capabilities: ["chat"] };
  return { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
}

test("bearer clients redeem guest invites with no Origin header", async t => {
  const { store, request, ownerKey } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  const identity = store.identities.create("BearerProbe");
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card: signedCard(identity) },
  });
  assert.equal(redeemed.status, 201);
  const guest = await redeemed.json();
  assert.ok(guest.token.startsWith("ga1."), "a real ga1. credential is issued");
  assert.equal(guest.member.displayName, "BearerProbe (guest)");
});

test("redeemed guests rotate their credential with no Origin header", async t => {
  const { store, request, ownerKey } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  const identity = store.identities.create("BearerProbe");
  const guest = await (await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card: signedCard(identity) },
  })).json();
  const rotated = await request("/api/guest-invites/rotate", {
    method: "POST", token: guest.token, data: { roomId: "commons" },
  });
  assert.equal(rotated.status, 200);
  const value = await rotated.json();
  assert.ok(value.token.startsWith("ga1."));
  assert.notEqual(value.token, guest.token);
  assert.throws(() => store.authenticate(guest.token, "commons"), { code: "unauthenticated" });
});

test("share-link agent joins work with no Origin header", async t => {
  const { store, request, ownerKey } = await serve(t);
  const linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(ownerKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0,
  });
  const identity = store.identities.create("BearerProbe");
  const joined = await request("/api/share-links/join-agent", {
    method: "POST", token: identity.secret, data: { linkToken, displayName: "BearerProbe" },
  });
  assert.equal(joined.status, 201);
  const value = await joined.json();
  assert.equal(value.roomId, "commons");
});

test("owner bearer mints guest-agent links with no Origin header", async t => {
  const { request, ownerKey } = await serve(t);
  const minted = await request("/api/guest-agent-links", {
    method: "POST", token: ownerKey,
    data: { roomId: "commons", requestId: randomUUID(), linkToken: GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url"), expectedOwnerRevision: 0 },
  });
  assert.equal(minted.status, 201);
});

test("no bearer, no Origin: the gate still bites", async t => {
  const { request, ownerKey } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  // Redeem without any credential and without Origin: still origin_denied,
  // not a free pass into the auth logic.
  const noAuth = await request("/api/guest-invites/redeem", {
    method: "POST", data: { inviteCode: minted.code, card: {} },
  });
  assert.equal(noAuth.status, 403);
  assert.equal((await noAuth.json()).error.code, "origin_denied");
  // Public preview keeps its Origin requirement: the exemption is for
  // bearer clients only, not a blanket disable.
  const preview = await request("/api/guest-invites/preview", {
    method: "POST", data: { inviteCode: minted.code },
  });
  assert.equal(preview.status, 403);
  assert.equal((await preview.json()).error.code, "origin_denied");
});

test("browser cookie writes still require Origin (CSRF intact)", async t => {
  const { store, request } = await serve(t);
  store.createAccount("account-target");
  const accountAccessKey = store.issueAccountAccessKey("account-target");
  const bootstrapResponse = await request("/api/account-session", { origin: true });
  assert.equal(bootstrapResponse.status, 200);
  const slotCookie = bootstrapResponse.headers.get("set-cookie").split(";", 1)[0];
  const bootstrap = await bootstrapResponse.json();
  const login = await request("/api/account-session", {
    method: "POST", origin: true,
    headers: { Cookie: slotCookie, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey, expectedSessionRevision: bootstrap.sessionRevision },
  });
  assert.equal(login.status, 201);
  const sessionCookie = login.headers.get("set-cookie").split(";", 1)[0];
  const session = await login.json();
  // Cookie write without Origin: still denied.
  const denied = await request("/api/account/profile", {
    method: "POST",
    headers: { Cookie: sessionCookie, "X-CSRF-Token": session.csrf },
    data: { displayName: "Nope" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "origin_denied");
  // Same cookie write with Origin and CSRF: passes, so the denial above is
  // the Origin gate and nothing else.
  const allowed = await request("/api/account/profile", {
    method: "POST", origin: true,
    headers: { Cookie: sessionCookie, "X-CSRF-Token": session.csrf },
    data: { displayName: "BearerProbe Owner" },
  });
  assert.equal(allowed.status, 200);
});
