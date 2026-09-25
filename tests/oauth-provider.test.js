// Tests for server/oauth-provider.mjs — OAuth2 authorization server.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOAuthProvider, OAuthProviderError, OAUTH_SCOPES } from "../server/oauth-provider.mjs";

const base64url = b => Buffer.from(b).toString("base64url");
const challengeFor = verifier => base64url(createHash("sha256").update(verifier).digest());

function setup() {
  let t = 1_000_000;
  const provider = createOAuthProvider({ clock: () => t });
  const advance = ms => { t += ms; };
  provider.registerClient({
    clientId: "muse",
    name: "Muse",
    redirectUris: ["https://muse.ai/oauth/callback"],
  });
  return { provider, advance };
}

const authParams = (overrides = {}) => ({
  clientId: "muse",
  redirectUri: "https://muse.ai/oauth/callback",
  scopes: ["rooms:read", "chat:read"],
  state: "xyz",
  codeChallenge: challengeFor("verifier-".padEnd(43, "x")),
  ...overrides,
});

test("registers a client and rejects duplicates", () => {
  const { provider } = setup();
  assert.throws(() => provider.registerClient({
    clientId: "muse", name: "Dup", redirectUris: ["https://example.com/cb"],
  }), OAuthProviderError);
  const client = provider.getClient("muse");
  assert.equal(client.name, "Muse");
  assert.deepEqual([...client.redirectUris], ["https://muse.ai/oauth/callback"]);
  assert.equal(provider.getClient("nope"), null);
});

test("rejects non-https redirect URIs (localhost http allowed)", () => {
  const { provider } = setup();
  assert.throws(() => provider.registerClient({
    clientId: "bad", name: "Bad", redirectUris: ["http://example.com/cb"],
  }), OAuthProviderError);
  const ok = provider.registerClient({
    clientId: "local", name: "Local", redirectUris: ["http://localhost:3000/cb"],
  });
  assert.equal(ok.clientId, "local");
});

test("validates authorization requests", () => {
  const { provider } = setup();
  const req = provider.validateAuthorizationRequest(authParams());
  assert.equal(req.client.clientId, "muse");
  assert.deepEqual([...req.scopes], ["rooms:read", "chat:read"]);
  assert.equal(req.state, "xyz");
  // unknown client
  assert.throws(() => provider.validateAuthorizationRequest(authParams({ clientId: "nope" })), OAuthProviderError);
  // redirect mismatch
  assert.throws(() => provider.validateAuthorizationRequest(authParams({ redirectUri: "https://evil.com/cb" })), OAuthProviderError);
  // unknown scope
  assert.throws(() => provider.validateAuthorizationRequest(authParams({ scopes: ["admin:all"] })), OAuthProviderError);
  // PKCE required
  assert.throws(() => provider.validateAuthorizationRequest(authParams({ codeChallenge: undefined })), OAuthProviderError);
});

test("full authorization code flow with PKCE", () => {
  const { provider } = setup();
  const verifier = "test-verifier-".padEnd(43, "a");
  const { code } = provider.issueCode({
    clientId: "muse",
    userId: "user-123",
    redirectUri: "https://muse.ai/oauth/callback",
    scopes: ["rooms:read", "chat:write"],
    codeChallenge: challengeFor(verifier),
  });
  assert.ok(code.startsWith("oac_"));
  const tokens = provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: verifier,
  });
  assert.equal(tokens.tokenType, "Bearer");
  assert.ok(tokens.accessToken.startsWith("oat_"));
  assert.ok(tokens.refreshToken.startsWith("oar_"));
  assert.deepEqual([...tokens.scopes], ["rooms:read", "chat:write"]);
  // code is single-use
  assert.throws(() => provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: verifier,
  }), OAuthProviderError);
});

test("rejects wrong PKCE verifier", () => {
  const { provider } = setup();
  const { code } = provider.issueCode({
    clientId: "muse", userId: "u1",
    redirectUri: "https://muse.ai/oauth/callback",
    scopes: ["rooms:read"],
    codeChallenge: challengeFor("correct-verifier-".padEnd(43, "a")),
  });
  assert.throws(() => provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: "wrong-verifier-".padEnd(43, "b"),
  }), /PKCE/);
});

test("rejects expired authorization codes", () => {
  const { provider, advance } = setup();
  const verifier = "v-".padEnd(43, "c");
  const { code } = provider.issueCode({
    clientId: "muse", userId: "u1",
    redirectUri: "https://muse.ai/oauth/callback",
    scopes: ["rooms:read"],
    codeChallenge: challengeFor(verifier),
  });
  advance(11 * 60 * 1000); // past 10-min TTL
  assert.throws(() => provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: verifier,
  }), /expired/);
});

test("verifies access tokens and checks scopes", () => {
  const { provider, advance } = setup();
  const verifier = "v-".padEnd(43, "d");
  const { code } = provider.issueCode({
    clientId: "muse", userId: "u1",
    redirectUri: "https://muse.ai/oauth/callback",
    scopes: ["chat:read", "chat:write"],
    codeChallenge: challengeFor(verifier),
  });
  const { accessToken } = provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: verifier,
  });
  const auth = provider.verifyAccessToken(accessToken);
  assert.equal(auth.userId, "u1");
  assert.equal(auth.clientId, "muse");
  assert.ok(provider.grants(accessToken, "chat:read"));
  assert.ok(provider.grants(accessToken, "chat:write"));
  assert.ok(!provider.grants(accessToken, "work:read"));
  assert.equal(provider.verifyAccessToken("bogus"), null);
  // expired access token
  advance(61 * 60 * 1000);
  assert.equal(provider.verifyAccessToken(accessToken), null);
});

test("refresh rotates tokens", () => {
  const { provider } = setup();
  const verifier = "v-".padEnd(43, "e");
  const { code } = provider.issueCode({
    clientId: "muse", userId: "u1",
    redirectUri: "https://muse.ai/oauth/callback",
    scopes: ["rooms:read"],
    codeChallenge: challengeFor(verifier),
  });
  const first = provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: verifier,
  });
  const second = provider.refresh({ refreshToken: first.refreshToken, clientId: "muse" });
  assert.notEqual(second.accessToken, first.accessToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.ok(provider.verifyAccessToken(second.accessToken));
  // old refresh token is single-use (rotated)
  assert.throws(() => provider.refresh({ refreshToken: first.refreshToken, clientId: "muse" }),
    OAuthProviderError);
});

test("revokes tokens (RFC 7009)", () => {
  const { provider } = setup();
  const verifier = "v-".padEnd(43, "f");
  const { code } = provider.issueCode({
    clientId: "muse", userId: "u1",
    redirectUri: "https://muse.ai/oauth/callback",
    scopes: ["rooms:read"],
    codeChallenge: challengeFor(verifier),
  });
  const { accessToken, refreshToken } = provider.exchangeCode({
    code, clientId: "muse",
    redirectUri: "https://muse.ai/oauth/callback",
    codeVerifier: verifier,
  });
  assert.equal(provider.revoke(accessToken), true);
  assert.equal(provider.verifyAccessToken(accessToken), null);
  assert.equal(provider.revoke(refreshToken), true);
  assert.throws(() => provider.refresh({ refreshToken, clientId: "muse" }), OAuthProviderError);
  // unknown token: still success per RFC 7009
  assert.equal(provider.revoke("unknown-token"), false);
});

test("revokeAllForUser disconnects a client", () => {
  const { provider } = setup();
  const mk = (user, scope) => {
    const verifier = `v-${user}-`.padEnd(43, "g");
    const { code } = provider.issueCode({
      clientId: "muse", userId: user,
      redirectUri: "https://muse.ai/oauth/callback",
      scopes: [scope],
      codeChallenge: challengeFor(verifier),
    });
    return provider.exchangeCode({
      code, clientId: "muse",
      redirectUri: "https://muse.ai/oauth/callback",
      codeVerifier: verifier,
    });
  };
  const a = mk("alice", "rooms:read");
  const b = mk("bob", "rooms:read");
  const count = provider.revokeAllForUser({ userId: "alice", clientId: "muse" });
  assert.equal(count, 2); // access + refresh
  assert.equal(provider.verifyAccessToken(a.accessToken), null);
  assert.ok(provider.verifyAccessToken(b.accessToken)); // bob untouched
});

test("exposes the documented scope list", () => {
  assert.deepEqual([...OAUTH_SCOPES],
    ["rooms:read", "chat:read", "chat:write", "work:read", "work:write"]);
});

// ---- F-02: access-token revocation cascade + session kill ----

// Owner-boundary contract: revoking a refresh token must kill its whole
// token family immediately. Regression: a "simpler" revoke() that only
// flips the presented token leaves access tokens valid to their 1h TTL,
// breaking the consent screen's "revoke access at any time" promise.
const mkPair = (provider, user, clientId = "muse", session) => {
  const client = provider.getClient(clientId);
  const redirectUri = client.redirectUris[0];
  const verifier = `v-${user}-${clientId}-`.padEnd(43, "h");
  const { code } = provider.issueCode({
    clientId, userId: user, redirectUri,
    scopes: ["rooms:read", "chat:read"],
    codeChallenge: challengeFor(verifier),
  });
  return provider.exchangeCode({
    code, clientId, redirectUri, codeVerifier: verifier, session,
  });
};

test("F-02: revoking a refresh token kills its access tokens immediately", () => {
  const { provider } = setup();
  const { accessToken, refreshToken } = mkPair(provider, "alice");
  assert.ok(provider.verifyAccessToken(accessToken));
  assert.equal(provider.revoke(refreshToken), true);
  assert.equal(provider.verifyAccessToken(accessToken), null); // no 1h linger
  assert.throws(() => provider.refresh({ refreshToken, clientId: "muse" }), /revoked/);
});

test("F-02: revoking an access token stays surgical", () => {
  const { provider } = setup();
  const { accessToken, refreshToken } = mkPair(provider, "alice");
  assert.equal(provider.revoke(accessToken), true);
  assert.equal(provider.verifyAccessToken(accessToken), null);
  // The family survives: the refresh token still rotates into a live pair.
  const next = provider.refresh({ refreshToken, clientId: "muse" });
  assert.ok(provider.verifyAccessToken(next.accessToken));
});

test("F-02: refresh-token reuse still triggers family revocation (F-01 intact)", () => {
  const { provider } = setup();
  const first = mkPair(provider, "alice");
  const second = provider.refresh({ refreshToken: first.refreshToken, clientId: "muse" });
  assert.throws(
    () => provider.refresh({ refreshToken: first.refreshToken, clientId: "muse" }),
    /reuse detected/);
  assert.equal(provider.verifyAccessToken(first.accessToken), null);
  assert.equal(provider.verifyAccessToken(second.accessToken), null); // family dead
});

test("F-02: revokeAllForUser without clientId kills every client", () => {
  const { provider } = setup();
  provider.registerClient({
    clientId: "other", name: "Other", redirectUris: ["https://other.example/cb"],
  });
  const a = mkPair(provider, "alice", "muse");
  const b = mkPair(provider, "alice", "other");
  const c = mkPair(provider, "bob", "muse");
  const count = provider.revokeAllForUser({ userId: "alice" });
  assert.equal(count, 4); // 2 access + 2 refresh across both clients
  assert.equal(provider.verifyAccessToken(a.accessToken), null);
  assert.equal(provider.verifyAccessToken(b.accessToken), null);
  assert.ok(provider.verifyAccessToken(c.accessToken)); // bob untouched
  assert.equal(provider.listSessions({ userId: "alice" }).length, 0);
});

test("F-02: listSessions shows live families with issuance metadata", () => {
  const { provider } = setup();
  const pair = mkPair(provider, "alice", "muse", { ip: "203.0.113.7", userAgent: "test-agent/1.0" });
  const sessions = provider.listSessions({ userId: "alice" });
  assert.equal(sessions.length, 1);
  const [s] = sessions;
  assert.ok(s.id.startsWith("oarf_"));
  assert.equal(s.clientId, "muse");
  assert.deepEqual([...s.scopes].sort(), ["chat:read", "rooms:read"]);
  assert.equal(s.ip, "203.0.113.7");
  assert.equal(s.userAgent, "test-agent/1.0");
  assert.equal(s.accessTokens, 1);
  assert.equal(s.refreshTokens, 1);
  assert.equal(typeof s.issuedAt, "number");
  // Cross-user isolation: nobody else's families are visible.
  assert.equal(provider.listSessions({ userId: "mallory" }).length, 0);
  // Rotation keeps one family (same id); a revoked family drops out.
  const next = provider.refresh({ refreshToken: pair.refreshToken, clientId: "muse" });
  const after = provider.listSessions({ userId: "alice" });
  assert.equal(after.length, 1);
  assert.equal(after[0].id, s.id);
  provider.revoke(next.refreshToken);
  assert.equal(provider.listSessions({ userId: "alice" }).length, 0);
});

test("F-02: revokeSession kills one family, ownership-checked", () => {
  const { provider, advance } = setup();
  const a = mkPair(provider, "alice");
  advance(1000);
  const b = mkPair(provider, "alice");
  const c = mkPair(provider, "bob");
  const [newest, oldest] = provider.listSessions({ userId: "alice" }); // newest first
  const bobId = provider.listSessions({ userId: "bob" })[0].id;
  // Cross-user kill attempt: rejected, bob's session untouched.
  assert.equal(provider.revokeSession({ userId: "alice", familyId: bobId }), 0);
  assert.ok(provider.verifyAccessToken(c.accessToken));
  // Kill alice's older family only.
  assert.equal(provider.revokeSession({ userId: "alice", familyId: oldest.id }), 2);
  assert.equal(provider.verifyAccessToken(a.accessToken), null);
  assert.ok(provider.verifyAccessToken(b.accessToken)); // other family alive
  assert.equal(newest.id, provider.listSessions({ userId: "alice" })[0].id);
  // Unknown family: no-op.
  assert.equal(provider.revokeSession({ userId: "alice", familyId: "oarf_nope" }), 0);
});
