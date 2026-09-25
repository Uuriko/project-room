// Attack-case test suite for server/oauth-provider.mjs.
//
// Threat-model review 2026-09-24 (200-list #95). Each test pins a security
// invariant at the module boundary — the owner of the token/code lifecycle.
// F-01 (refresh-token reuse theft detection) was FIXED 2026-09-25: the reuse
// test now asserts the new behavior — whole-family revocation plus a
// reuse-detected signal. F-02 (refresh-token revoke cascade) was FIXED
// 2026-09-25: the revocation tests now assert that revoking a refresh token
// kills the whole family immediately.
//
// Authoring-gate notes (repo .agents/skills/test-audit/SKILL.md):
//  1. Every test guards an observable security invariant of the OAuth2 flow.
//  2. Credible regressions: rotation/revocation refactors, scope plumbing
//     changes, redirect-URI matching loosened to prefix/subdomain, PKCE
//     downgrade re-introduced, code store semantics changed.
//  3. Existing tests/oauth-provider.test.js covers the happy path, single-use
//     codes, wrong-verifier PKCE, expiry, basic rotation, refresh-token
//     revoke cascade (F-02 fixed), and single-token access revocation. These
//     attack cases cover what it does not: replay AFTER downstream refresh,
//     failed-guess code survival, downgrade-shaped verifiers, refresh-chain
//     scope pinning, redirect-URI lookalikes, cross-client binding,
//     consent->grant binding, refresh-token reuse theft response (F-01
//     fixed), and explicit-revocation cascade without reuse signals (F-02
//     fixed).
//  4. No production seams: only the module's public API is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOAuthProvider, OAuthProviderError } from "../server/oauth-provider.mjs";

const base64url = b => Buffer.from(b).toString("base64url");
const challengeFor = verifier => base64url(createHash("sha256").update(verifier).digest());
const verifier = seed => `${seed}-verifier-`.padEnd(43, "x");

const CLIENT_A = "muse";
const CLIENT_B = "compromised-connector"; // a second REGISTERED client (threat actor)
const URI_A = "https://muse.ai/oauth/callback";
const URI_B = "https://muse.ai/oauth/callback-alt";
const URI_EVIL = "https://evil.example/oauth/callback";

function setup() {
  let t = 1_000_000;
  const provider = createOAuthProvider({ clock: () => t });
  const advance = ms => { t += ms; };
  provider.registerClient({ clientId: CLIENT_A, name: "Muse", redirectUris: [URI_A, URI_B] });
  provider.registerClient({ clientId: CLIENT_B, name: "Evil Connector", redirectUris: [URI_EVIL] });
  return { provider, advance };
}

// Run one full authorization-code grant and return { code, verifier, tokens }.
function fullGrant(provider, { clientId = CLIENT_A, redirectUri = URI_A, scopes = ["rooms:read"], userId = "user-1", seed = "flow" } = {}) {
  const v = verifier(seed);
  const { code } = provider.issueCode({
    clientId, userId, redirectUri, scopes, codeChallenge: challengeFor(v),
  });
  const tokens = provider.exchangeCode({ code, clientId, redirectUri, codeVerifier: v });
  return { code, verifier: v, tokens };
}

// ---------------------------------------------------------------------------
// 1. Authorization-code replay
// ---------------------------------------------------------------------------

test("replayed authorization code stays burned even after the derived tokens are refreshed", () => {
  // Invariant: a code is single-use for its whole 10-minute life, regardless
  // of what happens to the tokens minted from it. Regression: a refactor that
  // clears `used` when the derived refresh token rotates would reopen replay.
  const { provider } = setup();
  const { code, verifier: v, tokens } = fullGrant(provider);
  // Legitimate downstream activity: rotate the refresh token.
  const rotated = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  assert.ok(provider.verifyAccessToken(rotated.accessToken));
  // Attacker replays the original code (with the correct verifier, stolen or
  // observed) after the exchange already succeeded.
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: v,
  }), /already used/);
  // And the burned code is not resurrected by a second replay either.
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: v,
  }), /already used/);
});

test("failed PKCE guesses do not burn the code for the legitimate exchanger", () => {
  // Invariant: a wrong verifier fails closed WITHOUT consuming the code, so
  // an attacker who intercepts the code cannot DoS the legitimate flow by
  // burning it with bad guesses. Regression: moving `record.used = true`
  // before PKCE verification would turn every guess into a burn.
  const { provider } = setup();
  const v = verifier("survivor");
  const { code } = provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read"], codeChallenge: challengeFor(v),
  });
  // Attacker guesses (code intercepted, verifier unknown).
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: verifier("attacker-guess"),
  }), /PKCE verification failed/);
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: verifier("attacker-guess-2"),
  }), /PKCE verification failed/);
  // Legitimate client still exchanges successfully afterwards.
  const tokens = provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: v,
  });
  assert.ok(provider.verifyAccessToken(tokens.accessToken));
});

// ---------------------------------------------------------------------------
// 2. PKCE downgrade / verifier mismatch
// ---------------------------------------------------------------------------

test("PKCE plain-method downgrade attempts fail verification", () => {
  // Invariant: the server ALWAYS applies S256 (code_challenge_method=plain is
  // rejected at the HTTP layer and unrepresentable at the module layer), so
  // sending the challenge itself as the verifier — the classic downgrade —
  // must fail. Existing "rejects wrong PKCE verifier" uses a well-formed
  // wrong verifier; this pins the downgrade SHAPE plus length bounds.
  const { provider } = setup();
  const v = verifier("downgrade");
  const challenge = challengeFor(v);
  const { code } = provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read"], codeChallenge: challenge,
  });
  // Downgrade: verifier == challenge (what a `plain` client would send).
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: challenge,
  }), /PKCE verification failed/);
  // Truncated verifier.
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: "short",
  }), OAuthProviderError);
  // Undersized challenge never gets a code in the first place.
  assert.throws(() => provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read"], codeChallenge: "tooshort",
  }), OAuthProviderError);
});

// ---------------------------------------------------------------------------
// 3. Scope escalation
// ---------------------------------------------------------------------------

test("refresh cannot escalate scopes: the rotated pair carries the original grant exactly", () => {
  // Invariant: scopes are fixed at consent time (stored on the code record)
  // and neither the token request nor refresh accepts client-supplied scopes.
  // Regression: adding a `scopes` parameter to refresh(), or re-validating
  // from request data, would open escalation.
  const { provider } = setup();
  const { tokens } = fullGrant(provider, { scopes: ["rooms:read"] });
  const second = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  assert.deepEqual([...second.scopes], ["rooms:read"]);
  const third = provider.refresh({ refreshToken: second.refreshToken, clientId: CLIENT_A });
  assert.deepEqual([...third.scopes], ["rooms:read"]);
  // The access token grants exactly what was consented to — no more.
  assert.ok(provider.grants(third.accessToken, "rooms:read"));
  assert.equal(provider.grants(third.accessToken, "chat:read"), false);
  assert.equal(provider.grants(third.accessToken, "chat:write"), false);
  assert.equal(provider.grants(third.accessToken, "rooms:write"), false);
  assert.equal(provider.grants(third.accessToken, "work:read"), false);
});

// ---------------------------------------------------------------------------
// 4. Token leakage via redirect-uri manipulation
// ---------------------------------------------------------------------------

test("redirect-uri lookalikes are rejected at authorization time", () => {
  // Invariant: redirect_uri must EXACTLY match a registered URI — no prefix,
  // subdomain, query, case, or scheme leniency. A looser match would let an
  // attacker register a lookalike or smuggle the code to their own endpoint.
  // Existing coverage tests one mismatch (evil.com); this pins the lookalike
  // table at the owning boundary.
  const { provider } = setup();
  const params = overrides => ({
    clientId: CLIENT_A,
    redirectUri: URI_A,
    scopes: ["rooms:read"],
    codeChallenge: challengeFor(verifier("lookalike")),
    ...overrides,
  });
  const lookalikes = [
    "https://muse.ai.evil.com/oauth/callback", // subdomain spoof
    "https://muse.ai/oauth/callback?next=https://evil.com", // query injection
    "https://muse.ai/oauth/callback/", // trailing slash
    "https://muse.ai/oauth/callback-alt/", // trailing slash on the second URI
    "https://MUSE.AI/oauth/callback", // case variation
    "http://muse.ai/oauth/callback", // scheme downgrade
    "https://muse.ai/oauth/callback2", // prefix-adjacent path
    "https://muse.ai:443/oauth/callback", // explicit default port
  ];
  for (const redirectUri of lookalikes) {
    assert.throws(
      () => provider.validateAuthorizationRequest(params({ redirectUri })),
      OAuthProviderError,
      `lookalike accepted: ${redirectUri}`,
    );
  }
  // The legitimately registered second URI still works (no over-blocking).
  const ok = provider.validateAuthorizationRequest(params({ redirectUri: URI_B }));
  assert.equal(ok.redirectUri, URI_B);
});

test("authorization code is bound to its redirect_uri at exchange time", () => {
  // Invariant: even with a valid code, the correct verifier, and a registered
  // client, exchange fails unless redirect_uri is the EXACT one the code was
  // issued for. This kills code-phishing where the code is redeemed against a
  // different registered endpoint of the same client.
  const { provider } = setup();
  const v = verifier("bound");
  const { code } = provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read"], codeChallenge: challengeFor(v),
  });
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_B, codeVerifier: v,
  }), /redirect_uri mismatch/);
  // The code is NOT burned by the failed attempt; the legitimate exchange works.
  const tokens = provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: v,
  });
  assert.ok(provider.verifyAccessToken(tokens.accessToken));
});

// ---------------------------------------------------------------------------
// 5. Refresh-token reuse
// ---------------------------------------------------------------------------

test("rotated refresh-token replay triggers theft response: distinct invalid_grant and the whole family dies", () => {
  // Invariant (F-01 fixed): rotation is single-use; a replayed (rotated)
  // refresh token is treated as theft, not a silent reject — the whole token
  // family derived from the grant is revoked (OAuth Security BCP §4.12 /
  // RFC 6749 §6) and the caller gets a distinct invalid_grant signal.
  // This supersedes the old "live chain unpoisoned" invariant: the provider
  // cannot distinguish attacker from legitimate user, so the safe action is
  // to kill the family and let the user re-authenticate.
  const { provider } = setup();
  const { tokens } = fullGrant(provider);
  const second = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  // Attacker replays the old (rotated) refresh token.
  assert.throws(() => provider.refresh({
    refreshToken: tokens.refreshToken, clientId: CLIENT_A,
  }), err => err instanceof OAuthProviderError
    && err.code === "invalid_grant" && /reuse detected/.test(err.message));
  // The theft response killed the whole family: every access and refresh
  // token derived from the grant is dead, including the new chain.
  assert.equal(provider.verifyAccessToken(second.accessToken), null);
  assert.equal(provider.verifyAccessToken(tokens.accessToken), null);
  assert.throws(() => provider.refresh({
    refreshToken: second.refreshToken, clientId: CLIENT_A,
  }), /refresh token revoked/);
  assert.deepEqual([...second.scopes], ["rooms:read"]);
});

test("FIXED (F-01): refresh-token reuse revokes the whole token family and emits a signal", () => {
  // -----------------------------------------------------------------------
  // FIXED — see REVIEW.md F-01. Reuse of a rotated refresh token signals
  // theft (OAuth Security BCP §4.12 / RFC 6749 §6): the provider revokes the
  // whole token family derived from the grant, emits a
  // refresh_token_reuse_detected security event, and answers with a distinct
  // invalid_grant so the legitimate user gets a signal (previously: silent
  // "revoked", attacker's chain stayed valid).
  // -----------------------------------------------------------------------
  const events = [];
  let t = 1_000_000;
  const provider = createOAuthProvider({
    clock: () => t,
    onSecurityEvent: event => { events.push(event); },
  });
  provider.registerClient({ clientId: CLIENT_A, name: "Muse", redirectUris: [URI_A, URI_B] });
  const { tokens } = fullGrant(provider, { userId: "victim" });
  // Attacker steals the refresh token and uses it FIRST.
  const stolen = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  assert.ok(provider.verifyAccessToken(stolen.accessToken), "attacker chain works");
  // Legitimate user now finds their token dead — with a theft signal.
  assert.throws(() => provider.refresh({
    refreshToken: tokens.refreshToken, clientId: CLIENT_A,
  }), err => err instanceof OAuthProviderError
    && err.code === "invalid_grant" && /reuse detected/.test(err.message));
  // The attacker's derived family IS revoked: access token dead, and the
  // attacker cannot keep rotating.
  assert.equal(
    provider.verifyAccessToken(stolen.accessToken),
    null,
    "F-01: attacker access token revoked after reuse detection",
  );
  assert.throws(() => provider.refresh({
    refreshToken: stolen.refreshToken, clientId: CLIENT_A,
  }), /refresh token revoked/,
    "F-01: attacker's refresh token is dead after the family nuke (plain revoked — the theft was already signaled once)");
  // The victim's original access token (same family) is revoked too.
  assert.equal(
    provider.verifyAccessToken(tokens.accessToken),
    null,
    "F-01: victim's original access token revoked as part of the family",
  );
  // The reuse-detected signal fired exactly once with the family context.
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "refresh_token_reuse_detected");
  assert.equal(events[0].userId, "victim");
  assert.equal(events[0].clientId, CLIENT_A);
  assert.ok(typeof events[0].familyId === "string" && events[0].familyId.startsWith("oarf_"));
  assert.ok(events[0].revokedCount >= 3);
  assert.equal(events[0].detectedAt, t);
});

test("F-02: explicitly revoked refresh tokens kill the family, without a reuse signal", () => {
  // Invariant: explicit revocation via revoke() kills the whole token family
  // (the consent screen's "revoke access at any time" promise), but it is
  // not theft — no refresh_token_reuse_detected event fires. Regression: a
  // refactor that treats every revoked-token replay as reuse would emit
  // false theft signals on benign replays.
  const events = [];
  const provider = createOAuthProvider({ onSecurityEvent: event => { events.push(event); } });
  provider.registerClient({ clientId: CLIENT_A, name: "Muse", redirectUris: [URI_A, URI_B] });
  const { tokens } = fullGrant(provider);
  const second = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  provider.revoke(second.refreshToken);
  assert.throws(() => provider.refresh({
    refreshToken: second.refreshToken, clientId: CLIENT_A,
  }), /refresh token revoked/);
  assert.equal(events.length, 0, "explicit revocation must not emit a reuse signal");
  // F-02 cascade: the access tokens issued alongside die with the family.
  assert.equal(provider.verifyAccessToken(second.accessToken), null);
});

// ---------------------------------------------------------------------------
// 6. Revocation completeness
// ---------------------------------------------------------------------------

test("F-02 FIXED: revoking a refresh token kills its access tokens", () => {
  // -----------------------------------------------------------------------
  // F-02 fixed 2026-09-25: revoking a refresh token cuts the whole grant —
  // dependent access tokens die immediately, so "disconnect" is actually
  // complete. Previously revoke() marked one token only and access tokens
  // stayed valid for up to their 1-hour TTL. (revokeAllForUser was and is
  // the complete path — covered by existing tests.)
  // -----------------------------------------------------------------------
  const { provider } = setup();
  const { tokens } = fullGrant(provider);
  assert.equal(provider.revoke(tokens.refreshToken), true);
  assert.throws(() => provider.refresh({
    refreshToken: tokens.refreshToken, clientId: CLIENT_A,
  }), /refresh token revoked/);
  // FIXED: the access token from the same grant dies with the family.
  assert.equal(
    provider.verifyAccessToken(tokens.accessToken), null,
    "F-02: access token must die when its refresh token is revoked",
  );
});

test("revoking an access token kills it immediately for verify and grants", () => {
  // Invariant (the half of revocation that DOES work): a revoked access
  // token is unusable right away. Regression guard for the revoke() path.
  const { provider } = setup();
  const { tokens } = fullGrant(provider, { scopes: ["chat:read", "chat:write"] });
  assert.equal(provider.revoke(tokens.accessToken), true);
  assert.equal(provider.verifyAccessToken(tokens.accessToken), null);
  assert.equal(provider.grants(tokens.accessToken, "chat:read"), false);
  // The refresh token from the same grant still works (independent revocation).
  const second = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  assert.ok(provider.verifyAccessToken(second.accessToken));
});

// ---------------------------------------------------------------------------
// 7. Client impersonation
// ---------------------------------------------------------------------------

test("client impersonation at the token endpoint fails: codes and refresh tokens are client-bound", () => {
  // Invariant: the token endpoint authenticates the grant by binding, not by
  // trust — a code or refresh token minted for client A cannot be redeemed
  // with client B's id, even when B is a legitimately registered client and
  // the attacker knows the PKCE verifier. Threat model: a compromised
  // connector client trying to launder another client's grants.
  // (token_endpoint_auth_methods_supported is "none": public clients + PKCE.)
  const { provider } = setup();
  const v = verifier("impersonate");
  const { code } = provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read"], codeChallenge: challengeFor(v),
  });
  // Attacker client redeems victim's code with the CORRECT verifier.
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_B, redirectUri: URI_EVIL, codeVerifier: v,
  }), /client_id mismatch/);
  // Even with the right redirect URI shape, the client binding holds.
  assert.throws(() => provider.exchangeCode({
    code, clientId: CLIENT_B, redirectUri: URI_A, codeVerifier: v,
  }), /client_id mismatch/);
  // Legitimate exchange still works after the impersonation attempts.
  const tokens = provider.exchangeCode({
    code, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: v,
  });
  // Attacker client cannot refresh the victim's refresh token either.
  assert.throws(() => provider.refresh({
    refreshToken: tokens.refreshToken, clientId: CLIENT_B,
  }), /client_id mismatch/);
  const second = provider.refresh({ refreshToken: tokens.refreshToken, clientId: CLIENT_A });
  assert.ok(provider.verifyAccessToken(second.accessToken));
});

// ---------------------------------------------------------------------------
// 8. Consent confusion: the grant cannot exceed the consented request
// ---------------------------------------------------------------------------

test("the issued grant is bound to the exact consented request", () => {
  // Invariant: issueCode re-validates client/redirect/scopes/challenge, so a
  // code can never be minted for scopes the consent screen did not show, and
  // the exchange-time PKCE challenge is the one from THAT request — a
  // verifier from a different flow (different challenge) fails.
  const { provider } = setup();
  // Unknown scope: no code is minted for something the allowlist rejects.
  assert.throws(() => provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read", "admin:all"], codeChallenge: challengeFor(verifier("consent-a")),
  }), /unknown scopes/);
  // Two parallel flows; cross-flow verifier must fail even though both are
  // well-formed (challenges differ).
  const vA = verifier("consent-flow-a");
  const vB = verifier("consent-flow-b");
  const { code: codeA } = provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["rooms:read"], codeChallenge: challengeFor(vA),
  });
  provider.issueCode({
    clientId: CLIENT_A, userId: "user-1", redirectUri: URI_A,
    scopes: ["chat:write"], codeChallenge: challengeFor(vB),
  });
  assert.throws(() => provider.exchangeCode({
    code: codeA, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: vB,
  }), /PKCE verification failed/);
  // The right verifier for the right code yields exactly the consented scopes.
  const tokens = provider.exchangeCode({
    code: codeA, clientId: CLIENT_A, redirectUri: URI_A, codeVerifier: vA,
  });
  assert.deepEqual([...tokens.scopes], ["rooms:read"]);
  assert.equal(provider.grants(tokens.accessToken, "chat:write"), false);
});
