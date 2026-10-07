// Lane A4 (secrets handling) audit 2026-10-07: regression tests locking in
// the invariant that credentials NEVER echo back in error responses, logs,
// or security events.
//
// Every surface below was live-probed against production
// (https://room.trydemigod.com @ 8a4b3a6a) with bad credentials and read
// back clean: the invalid credential appears nowhere in the answer. These
// tests pin that behavior so a future refactor cannot silently reintroduce
// an echo. They use obviously-fake credential shapes (never real secrets).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createOAuthProvider } from "../server/oauth-provider.mjs";

// Fake credential shapes: high-entropy, clearly synthetic, never real.
const fakeBearer = () => `pri_${randomBytes(24).toString("base64url")}`;
const fakeRefresh = () => `oarr_${randomBytes(32).toString("base64url")}`;
const fakeInviteCode = () => `INV-${randomBytes(16).toString("base64url")}`;

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const bodyText = async res => {
  const text = await res.text();
  // The error envelope may carry hints/next commands; the raw credential
  // must appear in none of them.
  return text;
};

// --- Unit: OAuth refresh-token-reuse security event carries no raw token ---

test("A4: refresh_token_reuse_detected security event never carries the raw refresh token", () => {
  const events = [];
  let t = 1_000_000;
  const provider = createOAuthProvider({ clock: () => t, onSecurityEvent: e => events.push(e) });
  provider.registerClient({ clientId: "a4-client", name: "A4", redirectUris: ["https://example.test/cb"] });
  // Mint a real pair through the provider's own authorization-code flow.
  const verifier = `a4verifier-${"x".repeat(40)}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { code } = provider.issueCode({
    clientId: "a4-client", userId: "victim",
    redirectUri: "https://example.test/cb", scopes: ["rooms:read"], codeChallenge: challenge,
  });
  const tokens = provider.exchangeCode({
    code, clientId: "a4-client",
    redirectUri: "https://example.test/cb", codeVerifier: verifier,
  });
  const rawRefresh = tokens.refreshToken;
  assert.ok(typeof rawRefresh === "string" && rawRefresh.length > 20, "fixture must mint a real-shaped token");
  // Attacker rotates first; victim's replay triggers the reuse signal.
  provider.refresh({ refreshToken: rawRefresh, clientId: "a4-client" });
  assert.throws(() => provider.refresh({ refreshToken: rawRefresh, clientId: "a4-client" }), /reuse detected/);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "refresh_token_reuse_detected");
  const serialized = JSON.stringify(events[0]);
  assert.ok(!serialized.includes(rawRefresh), "security event must not contain the raw refresh token");
  // Even a 20-char substring of the token must not leak (prefix included).
  for (let i = 0; i + 20 <= rawRefresh.length; i += 7) {
    assert.ok(!serialized.includes(rawRefresh.slice(i, i + 20)), "no token substring may leak into the event");
  }
});

// --- HTTP: bad credentials never echo in error responses ---

test("A4: bad Bearer <redacted> on /api/agent-keys answers 401 without echoing the credential", async t => {
  const origin = await startServer(t);
  const bad = fakeBearer();
  const res = await fetch(`${origin}/api/agent-keys`, { headers: { authorization: `Bearer ${bad}` } });
  assert.equal(res.status, 401);
  const text = await bodyText(res);
  assert.ok(!text.includes(bad), "401 response must not echo the presented credential");
});

test("A4: bad refresh token on /oauth/token answers without echoing the token", async t => {
  const origin = await startServer(t);
  const bad = fakeRefresh();
  const res = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: bad, client_id: "a4-client" }),
  });
  const text = await bodyText(res);
  assert.ok(!text.includes(bad), "token endpoint error must not echo the presented refresh token");
  assert.ok(res.status === 400 || res.status === 401, `expected 4xx, got ${res.status}`);
});

test("A4: bad invite code on /api/agent-invites/redeem answers without echoing the code", async t => {
  const origin = await startServer(t);
  const bad = fakeInviteCode();
  const res = await fetch(`${origin}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code: bad, displayName: "A4 probe" }),
  });
  const text = await bodyText(res);
  assert.ok(!text.includes(bad), "invite redeem error must not echo the presented code");
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
});

test("A4: bad invitation token on /api/invitations/preview answers without echoing the token", async t => {
  const origin = await startServer(t);
  const bad = fakeInviteCode();
  const res = await fetch(`${origin}/api/invitations/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ invitationToken: bad }),
  });
  const text = await bodyText(res);
  assert.ok(!text.includes(bad), "invitation preview error must not echo the presented token");
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
});
