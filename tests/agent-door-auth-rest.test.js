// AGENT-DOOR-AUTH stage 1, Lane B: REST resource-side OAuth validation.
//
// A server-recognized `oat_` access token (minted through a provider
// instance sharing the room store's database — the server's own provider
// reads the same tables) now authenticates room routes in mode "oauth":
// the provider proves the grant, the store proves membership
// (member_accounts -> active human member), and the route's OAuth scope
// classification (server/http.mjs OAUTH_ROUTE_SCOPES) gates what the grant
// may reach. Scopes only restrict the consenting account's own membership.
//
// Pins here:
// - one success route per scope class (rooms:read, chat:read, chat:write,
//   work:read, work:write) plus the multi-class activation-pack bundle,
//   which requires rooms:read + chat:read + work:read together;
// - missing scope -> 403 insufficient_scope naming the scope;
// - valid token + non-member account -> 403 access_denied;
// - expired / revoked / deactivated-account tokens -> 401 unauthenticated,
//   indistinguishable from other bad credentials;
// - CLOSED routes (snapshot incl. ?view=work, stream, events, commands,
//   updates, legacy work-claims, money families) -> 403 insufficient_scope
//   "OAuth credentials are not accepted for this route", even with every
//   scope granted;
// - direct store.authenticate surfaces stay closed for a VALID token:
//   /api/session room mode and /api/web/fetch answer 401 (the store does
//   not know oat_), and /api/session account mode keeps its 403;
// - scopes never widen membership: a plain member with every scope still
//   gets the member-level denial on an owner-gated read.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { createWork } from "../server/work-claims.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ALL_SCOPES = ["rooms:read", "chat:read", "chat:write", "work:read", "work:write"];
const CLOSED_MESSAGE = "OAuth credentials are not accepted for this route";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-rest-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.createAccount("account-other");
  const ownerKey = store.issueAccessKey("commons", "owner", 7 * 86400000, "account-owner");
  // A plain human member (no permissions, not the owner, sponsors nobody)
  // bound to its own account — the never-widen fixture.
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "plain", displayName: "Plain Member", kind: "human", permissions: [] },
  });
  store.bindHumanAccount("commons", "plain", "account-plain");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = "GET", token, data } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  // Mint a token the SERVER's provider will verify: a second provider
  // instance over the same database (the durable provider store is the
  // shared state; registration + issuance write the rows the server reads).
  const provider = createOAuthProvider({ db: store.db, clock: () => store.now() });
  provider.registerClient({
    clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"],
  });
  const mint = (userId, scopes) => {
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const { code } = provider.issueCode({
      clientId: "muse", userId, redirectUri: "https://muse.ai/oauth/callback", scopes, codeChallenge,
    });
    const { accessToken } = provider.exchangeCode({
      code, clientId: "muse", redirectUri: "https://muse.ai/oauth/callback", codeVerifier: verifier,
    });
    assert.match(accessToken, /^oat_[A-Za-z0-9_-]{43}$/);
    return accessToken;
  };
  const seedClaim = (id = "claim-1") => {
    const now = Date.now();
    store.workClaims.set("commons", createWork({ id, title: `seeded ${id}` }, { now: now - 60000 }));
    return id;
  };
  return { store, origin, request, mint, provider, seedClaim, ownerKey };
}

test("oauth success: one route per scope class, plus the multi-class activation pack", async t => {
  const f = await serve(t);
  f.seedClaim();

  // rooms:read — agent fleet overview (owner member) and the room's
  // verified-agents policy flag.
  const rooms = await f.request("/api/rooms/commons/agents/overview", { token: f.mint("account-owner", ["rooms:read"]) });
  assert.equal(rooms.status, 200);
  assert.equal(rooms.body.roomId, "commons");
  assert.equal(rooms.body.scope, "room");
  const policy = await f.request("/api/rooms/commons/verification-policy", { token: f.mint("account-owner", ["rooms:read"]) });
  assert.equal(policy.status, 200);

  // chat:read — the caller's DM consent pairs.
  const chatRead = await f.request("/api/rooms/commons/dm-consents", { token: f.mint("account-owner", ["chat:read"]) });
  assert.equal(chatRead.status, 200);
  assert.ok(Array.isArray(chatRead.body));

  // chat:write — typing heartbeat (ephemeral chat presence write).
  const chatWrite = await f.request("/api/rooms/commons/typing", { method: "POST", token: f.mint("account-owner", ["chat:write"]) });
  assert.equal(chatWrite.status, 200);
  assert.equal(chatWrite.body.ok, true);

  // work:read — the stored board claim page carries the seeded claim.
  const workRead = await f.request("/api/rooms/commons/work-claims-read", { token: f.mint("account-owner", ["work:read"]) });
  assert.equal(workRead.status, 200);
  assert.ok(workRead.body.claims.some(claim => claim.id === "claim-1"));

  // work:write — close the seeded claim (room owner authority inside the
  // claim rules; the OAuth scope is what the door checks).
  const workWrite = await f.request("/api/rooms/commons/work-claims/claim-1/close", {
    method: "POST", token: f.mint("account-owner", ["work:write"]), data: {},
  });
  assert.equal(workWrite.status, 200);
  assert.equal(workWrite.body.state, "closed");

  // Multi-class bundle: activation pack discloses room metadata, pinned
  // message bodies and open work together — all three read scopes succeed.
  const pack = await f.request("/api/rooms/commons/activation-pack", {
    token: f.mint("account-owner", ["rooms:read", "chat:read", "work:read"]),
  });
  assert.equal(pack.status, 200);
  assert.equal(pack.body.room.slug, "commons");
});

test("oauth scope gate: missing scope is 403 insufficient_scope naming the scope", async t => {
  const f = await serve(t);
  const cases = [
    ["rooms:read route, chat-only grant", "/api/rooms/commons/agents/overview", "GET", ["chat:read"], "rooms:read"],
    ["work:read route, rooms-only grant", "/api/rooms/commons/work-claims-read", "GET", ["rooms:read"], "work:read"],
    ["chat:write route, read-only grant", "/api/rooms/commons/typing", "POST", ["chat:read"], "chat:write"],
    ["work:write route, read-only grant", "/api/rooms/commons/work-claims/claim-1/close", "POST", ["work:read"], "work:write"],
    // The bundle needs every class it discloses: dropping chat:read names it.
    ["activation pack without chat:read", "/api/rooms/commons/activation-pack", "GET", ["rooms:read", "work:read"], "chat:read"],
    ["member card without rooms:read", "/api/rooms/commons/members/owner/card", "GET", ["work:read"], "rooms:read"],
  ];
  for (const [label, path, method, scopes, required] of cases) {
    const res = await f.request(path, { method, token: f.mint("account-owner", scopes), data: method === "POST" ? {} : undefined });
    assert.equal(res.status, 403, label);
    assert.equal(res.body.error.code, "insufficient_scope", label);
    assert.equal(res.body.error.message, `OAuth token lacks the ${required} scope`, label);
    // Same envelope shape as the api-key gate: reason stays access_denied.
    assert.equal(res.body.reason, "access_denied", label);
  }
});

test("oauth binding: valid token for a non-member account is 403 access_denied", async t => {
  const f = await serve(t);
  const res = await f.request("/api/rooms/commons/agents/overview", { token: f.mint("account-other", ["rooms:read"]) });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "access_denied");
  assert.equal(res.body.error.message, "This account has no membership in that Room");
});

test("oauth invalid tokens: expired, revoked, and deactivated-account tokens are the same 401", async t => {
  const f = await serve(t);
  const path = "/api/rooms/commons/agents/overview";

  const expired = f.mint("account-owner", ["rooms:read"]);
  f.store.db.prepare("UPDATE oauth_provider_access_tokens SET expires_at=1").run();
  const expiredRes = await f.request(path, { token: expired });
  assert.equal(expiredRes.status, 401);
  assert.equal(expiredRes.body.error.code, "unauthenticated");
  assert.equal(expiredRes.body.error.message, "Session or key expired or revoked");

  const revoked = f.mint("account-owner", ["rooms:read"]);
  assert.equal(f.provider.revoke(revoked), true);
  const revokedRes = await f.request(path, { token: revoked });
  assert.equal(revokedRes.status, 401);
  assert.equal(revokedRes.body.error.code, "unauthenticated");
  assert.equal(revokedRes.body.error.message, expiredRes.body.error.message);

  const deactivated = f.mint("account-owner", ["rooms:read"]);
  f.store.db.prepare("UPDATE accounts SET active=0 WHERE id='account-owner'").run();
  const deactivatedRes = await f.request(path, { token: deactivated });
  assert.equal(deactivatedRes.status, 401);
  assert.equal(deactivatedRes.body.error.code, "unauthenticated");
  assert.equal(deactivatedRes.body.error.message, expiredRes.body.error.message);

  // An unknown token of the right shape is indistinguishable.
  const unknownRes = await f.request(path, { token: "oat_" + "Q".repeat(43) });
  assert.equal(unknownRes.status, 401);
  assert.equal(unknownRes.body.error.message, expiredRes.body.error.message);
});

test("oauth closed routes: full scopes still get 403 insufficient_scope, naming no scope", async t => {
  const f = await serve(t);
  const token = f.mint("account-owner", ALL_SCOPES);
  const closed = [
    ["snapshot (default view)", "GET", "/api/rooms/commons"],
    ["snapshot (?view=work)", "GET", "/api/rooms/commons?view=work"],
    ["stream", "GET", "/api/rooms/commons/stream"],
    ["events", "GET", "/api/rooms/commons/events"],
    ["commands", "POST", "/api/rooms/commons/commands"],
    ["updates list", "GET", "/api/rooms/commons/updates"],
    ["legacy work-claims list", "GET", "/api/rooms/commons/work-claims"],
    ["next-actions", "GET", "/api/rooms/commons/next-actions"],
    ["bounties list (money)", "GET", "/api/rooms/commons/bounties"],
    ["credits transfer (money)", "POST", "/api/rooms/commons/credits/transfer"],
    ["bonds (money)", "GET", "/api/rooms/commons/bonds"],
    ["session-adjacent account rooms list is not a room route", "GET", "/api/rooms/commons/export"],
  ];
  for (const [label, method, path] of closed) {
    const res = await f.request(path, { method, token, data: method === "POST" ? {} : undefined });
    assert.equal(res.status, 403, label);
    assert.equal(res.body.error.code, "insufficient_scope", label);
    assert.equal(res.body.error.message, CLOSED_MESSAGE, label);
  }
});

test("oauth direct-authenticate surfaces stay closed for a VALID token", async t => {
  const f = await serve(t);
  const token = f.mint("account-owner", ALL_SCOPES);

  // /api/session room mode calls store.authenticate directly: the store
  // does not know oat_, so a valid OAuth token fails closed with the
  // store's unknown-credential 401.
  const session = await f.request("/api/session", { token });
  assert.equal(session.status, 401);
  assert.equal(session.body.error.code, "unauthenticated");
  assert.equal(session.body.error.message, "Sign in with an active room key or agent identity secret");

  // /api/session account mode (?room=) still rejects ANY bearer with 403
  // before bearer parsing — untouched by this lane.
  const sessionAccount = await f.request("/api/session?room=commons", { token });
  assert.equal(sessionAccount.status, 403);
  assert.equal(sessionAccount.body.error.code, "access_denied");
  assert.equal(sessionAccount.body.error.message, ["Account browser sessions do not use bearer", "authorization"].join(" "));

  // /api/web/fetch also authenticates through store.authenticate directly.
  const fetchRes = await f.request("/api/web/fetch", { method: "POST", token, data: { url: "https://example.com" } });
  assert.equal(fetchRes.status, 401);
  assert.equal(fetchRes.body.error.code, "unauthenticated");
  assert.equal(fetchRes.body.error.message, "Sign in with an active room key or agent identity secret");
});

test("oauth scopes restrict but never widen: a plain member with every scope is still member-denied", async t => {
  const f = await serve(t);
  // account-plain is an active human member with no permissions: the fleet
  // overview is owner/sponsor-gated inside the handler, and no OAuth scope
  // changes that.
  const res = await f.request("/api/rooms/commons/agents/overview", { token: f.mint("account-plain", ALL_SCOPES) });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "owner_required");
  // The same member CAN use a route its membership allows (its own
  // ready-work preference), proving the denial above is the member check,
  // not the OAuth door.
  const own = await f.request("/api/rooms/commons/members/me/wants-work", { token: f.mint("account-plain", ["work:read"]) });
  assert.equal(own.status, 200);
  assert.equal(own.body.memberId, "plain");
});

test("oauth malformed oat_ shapes still die at the bearer format gate", async t => {
  const f = await serve(t);
  for (const token of ["oat_" + "A".repeat(42), "oat_" + "A".repeat(44), "oat_" + "A".repeat(42) + "!"]) {
    const res = await f.request("/api/rooms/commons/agents/overview", { token });
    assert.equal(res.status, 401, token);
    assert.equal(res.body.error.code, "unauthenticated");
    assert.equal(res.body.error.message, "Invalid Authorization header");
  }
});
