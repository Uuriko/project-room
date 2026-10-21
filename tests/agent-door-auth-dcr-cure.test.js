// CURE-4445-DCR: the dynamic-registration impersonation cure, driven the
// way John's Tab found the defects (room seq 17100) — a stranger registers
// through the public RFC 7591 door under a provisioned connector's name,
// and a consenting user reads the consent screen.
//
// Pinned here:
// - a provisioned client's NAME is reserved at the public door: an exact,
//   case-variant, or whitespace-padded copy is refused with the RFC 7591
//   error name invalid_client_metadata; fresh names still register;
// - the consent screen for a dynamically registered (dcr_) client names
//   the redirect host the flow will deliver to and marks the client as
//   self-registered / not verified, in the consent decision area; a
//   provisioned client's screen carries no such block;
// - registration scopes are STORED on the client record as the
//   intersection with the server's requestable set (OAUTH_SCOPES): the
//   registration response reports exactly that set, a later read of the
//   client returns it, and a scope request with nothing requestable in
//   it keeps the pre-cure refusal (invalid_client_metadata).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider, OAuthProviderError, OAUTH_SCOPES } from "../server/oauth-provider.mjs";

const PROVISIONED = Object.freeze({
  clientId: "chatgpt", name: "ChatGPT", redirectUris: ["https://chatgpt.com/oauth/callback"],
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-dcr-cure-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const server = createRoomServer({ store, connectorClients: [PROVISIONED] });
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

const challengeFor = () => {
  const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
  return Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
};

const authorizeScreen = async (f, { clientId, redirectUri, scope = "rooms:read" }) => {
  const query = "/oauth/authorize?response_type=code&client_id=" + clientId
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent(scope)
    + "&state=s7&code_challenge=" + challengeFor() + "&code_challenge_method=S256";
  const screen = await fetch(f.origin + query, { headers: { cookie: f.accountCookie } });
  return { status: screen.status, html: await screen.text() };
};

test("registration door: a provisioned client's name is reserved, in every surface form", async t => {
  const f = await serve(t);
  for (const name of ["ChatGPT", "chatgpt", "CHATGPT", "  ChatGPT  "]) {
    const res = await registerClient(f.origin, {
      client_name: name, redirect_uris: ["https://evil.example/cb"],
    });
    assert.equal(res.status, 400, `name ${JSON.stringify(name)} must be refused`);
    assert.equal(res.body.error, "invalid_client_metadata", `name ${JSON.stringify(name)}`);
  }
  // The copied redirect does not save it either: name alone is the reservation.
  const copycat = await registerClient(f.origin, {
    client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/oauth/callback"],
  });
  assert.equal(copycat.status, 400);
  assert.equal(copycat.body.error, "invalid_client_metadata");
  // A fresh name registers exactly as before.
  const fresh = await registerClient(f.origin, {
    client_name: "My Own Tool", redirect_uris: ["https://tool.example/cb"],
  });
  assert.equal(fresh.status, 201);
  assert.match(fresh.body.client_id, /^dcr_/);
  assert.equal(fresh.body.client_name, "My Own Tool");
});

test("consent screen: a dynamic client names its redirect host and its unverified status", async t => {
  const f = await serve(t);
  const registered = await registerClient(f.origin, {
    client_name: "Specimen Connector", redirect_uris: ["https://specimen.example/cb"],
  });
  assert.equal(registered.status, 201);
  const screen = await authorizeScreen(f, {
    clientId: registered.body.client_id, redirectUri: "https://specimen.example/cb",
  });
  assert.equal(screen.status, 200);
  assert.match(screen.html, /data-dynamic-client/, "the dynamic-client notice is present");
  assert.ok(screen.html.includes("specimen.example"), "the redirect host is named on the consent screen");
  assert.match(screen.html, /registered itself/, "the client is marked self-registered");
  assert.match(screen.html, /not verified|no verification|unverified/i, "the client is marked not verified");
  // The marking sits in the consent decision area: before the Allow/Deny form.
  assert.ok(screen.html.indexOf("data-dynamic-client") < screen.html.indexOf("<form"),
    "the notice precedes the consent form");

  // A provisioned client's screen carries no dynamic-client block.
  const provisioned = await authorizeScreen(f, {
    clientId: PROVISIONED.clientId, redirectUri: PROVISIONED.redirectUris[0],
  });
  assert.equal(provisioned.status, 200);
  assert.ok(!provisioned.html.includes("data-dynamic-client"),
    "provisioned consent screen has no dynamic-client notice");
});

test("registration door: scopes are stored as the requestable intersection and reported back", async t => {
  const f = await serve(t);
  const mixed = await registerClient(f.origin, {
    client_name: "Scope Tool", redirect_uris: ["https://scope.example/cb"],
    scope: "rooms:read admin:all chat:read",
  });
  assert.equal(mixed.status, 201);
  assert.equal(mixed.body.scope, "rooms:read chat:read",
    "the response reports only the requestable scopes, in request order");
  // Nothing requestable in the request keeps the refusal.
  const hopeless = await registerClient(f.origin, {
    client_name: "Hopeless Tool", redirect_uris: ["https://scope.example/cb"], scope: "admin:all",
  });
  assert.equal(hopeless.status, 400);
  assert.equal(hopeless.body.error, "invalid_client_metadata");
  // No scope in the metadata: the full requestable set, as before.
  const full = await registerClient(f.origin, {
    client_name: "Full Tool", redirect_uris: ["https://scope.example/cb"],
  });
  assert.equal(full.status, 201);
  assert.equal(full.body.scope, OAUTH_SCOPES.join(" "));
});

test("provider: reserved names refuse, scopes persist on the client record (memory + durable)", t => {
  const provider = createOAuthProvider({ clock: () => 1_700_000_000_000 });
  provider.registerClient({ clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"] });
  for (const name of ["Muse", "Muse", "  muse  "]) {
    let thrown = null;
    try { provider.registerDynamicClient({ name, redirectUris: ["https://evil.example/cb"] }); }
    catch (error) { thrown = error; }
    assert.ok(thrown instanceof OAuthProviderError, `name ${JSON.stringify(name)} throws`);
    assert.equal(thrown.code, "invalid_client_metadata", `name ${JSON.stringify(name)}`);
  }
  const minted = provider.registerDynamicClient({
    name: "Dyn", redirectUris: ["https://dyn.example/cb"], scopes: ["chat:read", "admin:all", "rooms:read"],
  });
  assert.deepEqual([...minted.scopes], ["chat:read", "rooms:read"]);
  assert.deepEqual([...provider.getClient(minted.clientId).scopes], ["chat:read", "rooms:read"]);
  // Identical re-registration still returns the same client.
  const again = provider.registerDynamicClient({
    name: "Dyn", redirectUris: ["https://dyn.example/cb"], scopes: ["chat:read", "admin:all", "rooms:read"],
  });
  assert.equal(again.clientId, minted.clientId);

  // Durable: the stored set survives a restart, and a pre-cure clients
  // table (no scopes column) gains the storage idempotently.
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-dcr-cure-db-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "oauth.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE oauth_provider_clients (
    client_id TEXT PRIMARY KEY, name TEXT NOT NULL,
    redirect_uris_json TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  legacy.close();
  const first = createOAuthProvider({ db: new DatabaseSync(file), clock: () => 1_700_000_000_000 });
  const durable = first.registerDynamicClient({
    name: "Durable Dyn", redirectUris: ["https://dyn.example/cb"], scopes: ["work:read"],
  });
  assert.deepEqual([...durable.scopes], ["work:read"]);
  const second = createOAuthProvider({ db: new DatabaseSync(file), clock: () => 1_700_000_000_000 });
  assert.deepEqual([...second.getClient(durable.clientId).scopes], ["work:read"]);
});
