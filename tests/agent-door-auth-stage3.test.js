// AGENT-DOOR-AUTH stage 3: RFC 9728 protected-resource metadata + RFC 7591
// dynamic client registration, driven by a scripted STANDARDS-SHAPED client.
//
// The specimen is the qualification subject: it knows nothing about this
// codebase. It starts from the resource URL, follows the RFC 9728
// resource_metadata challenge pointer to the metadata document, discovers
// the authorization server, registers itself through the RFC 7591 door
// (no manual provisioning — the server is built with connectorClients: []),
// completes the one-click authorization-code + PKCE flow as the approving
// human, and spends the token at the resource. Every leg fails first on
// the unpatched stage-2 stack (51a5af1079): no metadata document, no
// registration_endpoint in the RFC 8414 document, no registration door,
// and 401 challenges without the resource_metadata parameter.
//
// Also pinned:
// - the 401 challenge on BOTH doors (REST + /mcp) gains exactly the
//   resource_metadata parameter; non-OAuth 401 consumers keep their exact
//   prior shape (no WWW-Authenticate added) — the pinned-shape control;
// - registration errors map to RFC 7591 error names at the HTTP door
//   (invalid_redirect_uri / invalid_client_metadata);
// - POST /oauth/register is rate limited under the existing rate()
//   discipline (per-address family, 30/min);
// - provider level: dynamic registration mints server-side `dcr_` ids,
//   inherits the existing 30-day client TTL, and an identical
//   re-registration returns the same client with its TTL refreshed;
//   a provisioned client's id is never handed out by the dynamic door.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider, OAuthProviderError, OAUTH_SCOPES } from "../server/oauth-provider.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const challengeFor = (origin) =>
  `Bearer realm="project-room", resource_metadata="${origin}/.well-known/oauth-protected-resource", charset="UTF-8"`;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-stage3-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  // No connectorClients: nothing is provisioned by hand. The specimen's
  // client exists only because the registration door mints it.
  const server = createRoomServer({ store, connectorClients: [] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const accountKey = store.issueAccountAccessKey("account-owner");
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, accountKey, 0);
  const accountCookie = `account_session=${slot.token}`;
  return { store, origin, accountCookie };
}

const registerClient = async (origin, metadata) => {
  const response = await fetch(origin + "/oauth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const SPECIMEN_METADATA = {
  client_name: "Specimen Connector",
  redirect_uris: ["https://specimen.example/cb"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: "rooms:read chat:read",
};

test("specimen: a standards-shaped client discovers, registers, and completes the flow unaided", async t => {
  const f = await serve(t);

  // Leg 3a — RFC 9728 protected-resource metadata at the bare well-known
  // path (the resource is the whole API origin, so the path-suffixed
  // form does not apply).
  const prmResponse = await fetch(f.origin + "/.well-known/oauth-protected-resource");
  assert.equal(prmResponse.status, 200);
  const prm = await prmResponse.json();
  assert.equal(prm.resource, f.origin);
  assert.deepEqual(prm.authorization_servers, [f.origin]);
  assert.deepEqual([...prm.scopes_supported].sort(), [...OAUTH_SCOPES].sort());
  assert.deepEqual(prm.bearer_methods_supported, ["header"]);

  // Authorization-server discovery (RFC 8414), aligned with the PRM:
  // the AS named by the metadata serves a document whose issuer matches
  // and which now names the registration endpoint.
  const asResponse = await fetch(prm.authorization_servers[0] + "/.well-known/oauth-authorization-server");
  assert.equal(asResponse.status, 200);
  const asDoc = await asResponse.json();
  assert.equal(asDoc.issuer, prm.authorization_servers[0]);
  assert.equal(asDoc.registration_endpoint, f.origin + "/oauth/register");

  // Leg 3b — RFC 7591 dynamic registration. The client_id is minted by
  // the server; the client proposed none.
  const registered = await registerClient(f.origin, SPECIMEN_METADATA);
  assert.equal(registered.status, 201);
  assert.match(registered.body.client_id, /^dcr_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(registered.body.client_name, "Specimen Connector");
  assert.deepEqual(registered.body.redirect_uris, ["https://specimen.example/cb"]);
  assert.equal(registered.body.token_endpoint_auth_method, "none");
  assert.deepEqual(registered.body.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(registered.body.response_types, ["code"]);
  assert.ok(Number.isSafeInteger(registered.body.client_id_issued_at));
  assert.ok(Math.abs(registered.body.client_id_issued_at - Math.floor(Date.now() / 1000)) < 120);

  // Identical re-registration returns the SAME client (its TTL is
  // refreshed provider-side; proven on the fake clock below).
  const again = await registerClient(f.origin, SPECIMEN_METADATA);
  assert.equal(again.status, 201);
  assert.equal(again.body.client_id, registered.body.client_id);

  // The one-click flow with the registered client: consent screen ->
  // allow -> code -> token exchange (PKCE S256), all over HTTP.
  const client = { clientId: registered.body.client_id, redirectUri: "https://specimen.example/cb" };
  const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const query = "/oauth/authorize?response_type=code&client_id=" + client.clientId
    + "&redirect_uri=" + encodeURIComponent(client.redirectUri)
    + "&scope=" + encodeURIComponent("rooms:read chat:read")
    + "&state=s3&code_challenge=" + challenge + "&code_challenge_method=S256";
  const screen = await fetch(f.origin + query, { headers: { cookie: f.accountCookie } });
  assert.equal(screen.status, 200);
  const html = await screen.text();
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "consent form carries a csrf token");
  assert.match(html, /Specimen Connector/);
  const formBody = "decision=allow&client_id=" + client.clientId
    + "&redirect_uri=" + encodeURIComponent(client.redirectUri)
    + "&scope=" + encodeURIComponent("rooms:read chat:read")
    + "&state=s3&code_challenge=" + challenge
    + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf);
  const consent = await fetch(f.origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: f.accountCookie, origin: f.origin },
    body: formBody,
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const tokenResponse = await fetch(f.origin + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code", code,
      redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.match(tokens.access_token, /^oat_[A-Za-z0-9_-]{43}$/);

  // Spend the token at the resource (rooms:read route), then rotate via
  // the refresh grant the registration advertised.
  const resource = await fetch(f.origin + "/api/rooms/commons/verification-policy", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(resource.status, 200);
  const refreshed = await fetch(f.origin + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.clientId,
    }),
  });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json();
  assert.match(rotated.access_token, /^oat_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.access_token, tokens.access_token);
});

test("401 challenge: both doors gain resource_metadata; other 401 consumers keep their exact shape", async t => {
  const f = await serve(t);
  const fabricated = "oat_" + "Z".repeat(43);

  // REST door: an unknown OAuth bearer token gets the RFC 9728 §5.1
  // challenge pointer.
  const rest = await fetch(f.origin + "/api/rooms/commons/verification-policy", {
    headers: { Authorization: `Bearer ${fabricated}` },
  });
  assert.equal(rest.status, 401);
  assert.equal(rest.headers.get("www-authenticate"), challengeFor(f.origin));

  // MCP door: the same challenge, parameter added to the existing shape.
  const rpc = await fetch(f.origin + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${fabricated}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/list" }),
  });
  assert.equal(rpc.status, 401);
  assert.equal(rpc.headers.get("www-authenticate"), challengeFor(f.origin));

  // Pinned-shape control: 401 consumers outside the OAuth bearer path
  // are untouched — the account-session 401 and the malformed-header
  // format gate carry no WWW-Authenticate at all, exactly as before.
  const session = await fetch(f.origin + "/api/oauth/sessions");
  assert.equal(session.status, 401);
  assert.equal(session.headers.get("www-authenticate"), null);
  const malformed = await fetch(f.origin + "/api/rooms/commons/verification-policy", {
    headers: { Authorization: "Bearer not-a-token" },
  });
  assert.equal(malformed.status, 401);
  assert.equal(malformed.headers.get("www-authenticate"), null);
});

test("registration door: RFC 7591 error names and the rate limit", async t => {
  const f = await serve(t);
  const cases = [
    ["missing redirect_uris", { client_name: "No Uris" }, "invalid_client_metadata"],
    ["empty redirect_uris", { redirect_uris: [] }, "invalid_client_metadata"],
    ["non-https redirect uri", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    ["redirect uri with fragment", { redirect_uris: ["https://ok.example/cb#frag"] }, "invalid_redirect_uri"],
    ["unparseable redirect uri", { redirect_uris: ["::not a url::"] }, "invalid_redirect_uri"],
    ["unsupported grant type", { redirect_uris: ["https://ok.example/cb"], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    ["unsupported response type", { redirect_uris: ["https://ok.example/cb"], response_types: ["token"] }, "invalid_client_metadata"],
    ["confidential auth method", { redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
    ["unknown scope", { redirect_uris: ["https://ok.example/cb"], scope: "admin:all" }, "invalid_client_metadata"],
    ["overlong client name", { redirect_uris: ["https://ok.example/cb"], client_name: "x".repeat(81) }, "invalid_client_metadata"],
  ];
  for (const [label, metadata, error] of cases) {
    const res = await registerClient(f.origin, metadata);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error, error, label);
    assert.equal(typeof res.body.error_description, "string", label);
  }
  // Localhost http redirect URIs stay legal (RFC 6749 §3.1.2.1, as the
  // provider has always allowed).
  const local = await registerClient(f.origin, { redirect_uris: ["http://localhost:8911/cb"] });
  assert.equal(local.status, 201);

  // Rate limit: the family allows 30 registrations per address per
  // minute; the error cases above already spent part of this server's
  // budget, so hammer distinct registrations until the limiter answers
  // 429 — it must answer within the next 30 attempts.
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    const res = await registerClient(f.origin, {
      client_name: `Hammer ${i}`, redirect_uris: [`https://hammer-${i}.example/cb`],
    });
    if (res.status === 429) limited = res;
    else assert.equal(res.status, 201);
  }
  assert.ok(limited, "registration door must rate-limit");
  assert.equal(limited.body.error.code, "rate_limited");
});

test("provider: dynamic registration mints dcr_ ids, inherits the 30-day TTL, refreshes on identical re-registration", () => {
  let now = 1_000_000_000;
  const provider = createOAuthProvider({ clock: () => now });
  provider.registerClient({ clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"] });

  const metadata = { name: "Dyn", redirectUris: ["https://dyn.example/cb"] };
  const minted = provider.registerDynamicClient(metadata);
  assert.match(minted.clientId, /^dcr_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(provider.getClient(minted.clientId).name, "Dyn");
  // A dynamic registration never hands out a provisioned client's id.
  // CURE-4445-DCR: it never hands out a provisioned client's NAME either —
  // the copycat registration is refused outright (before this cure it
  // minted a distinct dcr_ id under the copied name: the impersonation
  // vector of room seq 17100).
  let copycatError = null;
  try { provider.registerDynamicClient({ name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"] }); }
  catch (error) { copycatError = error; }
  assert.ok(copycatError instanceof OAuthProviderError);
  assert.equal(copycatError.code, "invalid_client_metadata");
  assert.equal(provider.getClient("muse").name, "Muse");

  // TTL: live at 29 days; identical re-registration at day 29 returns
  // the same client and refreshes the TTL, so it is still live at day
  // 58 — and gone 31 days after the last registration.
  now += 29 * DAY_MS;
  assert.ok(provider.getClient(minted.clientId));
  const refreshed = provider.registerDynamicClient(metadata);
  assert.equal(refreshed.clientId, minted.clientId);
  assert.equal(refreshed.issuedAt, minted.issuedAt);
  now += 29 * DAY_MS;
  assert.ok(provider.getClient(minted.clientId));
  now += 31 * DAY_MS;
  assert.equal(provider.getClient(minted.clientId), null);

  // Distinct metadata mints a distinct client.
  const other = provider.registerDynamicClient({ name: "Dyn", redirectUris: ["https://dyn.example/other"] });
  assert.notEqual(other.clientId, minted.clientId);
});
