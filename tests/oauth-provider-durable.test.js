// OAuth grants have to outlive Durable Object eviction. These tests use a
// second provider over the same SQLite file, which is what a restart is.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { pruneOAuthProvider } from "../server/oauth-provider-store.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { RoomStore } from "../server/store.mjs";

const base64url = bytes => Buffer.from(bytes).toString("base64url");
const challengeFor = verifier => base64url(createHash("sha256").update(verifier).digest());
const sha256 = text => createHash("sha256").update(text).digest("hex");
const VERIFIER = "durable-verifier-".padEnd(43, "a");
const CLIENT = { clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"] };

function openDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-oauth-durable-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "oauth.sqlite");
}

function provider(file, clock) {
  const db = new DatabaseSync(file);
  return { db, provider: createOAuthProvider({ db, clock }) };
}

test("a token issued before a restart still works, and the raw token is not stored", t => {
  const file = openDb(t);
  let now = 1_700_000_000_000;
  const first = provider(file, () => now);
  first.provider.registerClient(CLIENT);
  const { code } = first.provider.issueCode({
    clientId: CLIENT.clientId, userId: "user-1", redirectUri: CLIENT.redirectUris[0],
    scopes: ["rooms:read"], codeChallenge: challengeFor(VERIFIER)
  });
  const issued = first.provider.exchangeCode({
    code, clientId: CLIENT.clientId, redirectUri: CLIENT.redirectUris[0], codeVerifier: VERIFIER
  });
  first.db.close();

  const second = provider(file, () => now);
  t.after(() => second.db.close());
  assert.equal(second.provider.getClient(CLIENT.clientId).name, "Muse");
  const auth = second.provider.verifyAccessToken(issued.accessToken);
  assert.equal(auth.userId, "user-1");
  assert.deepEqual([...auth.scopes], ["rooms:read"]);
  const refreshed = second.provider.refresh({ refreshToken: issued.refreshToken, clientId: CLIENT.clientId });
  assert.ok(second.provider.verifyAccessToken(refreshed.accessToken));

  const rows = [
    ...second.db.prepare("SELECT * FROM oauth_provider_clients").all(),
    ...second.db.prepare("SELECT * FROM oauth_provider_codes").all(),
    ...second.db.prepare("SELECT * FROM oauth_provider_access_tokens").all(),
    ...second.db.prepare("SELECT * FROM oauth_provider_refresh_tokens").all()
  ];
  const stored = JSON.stringify(rows);
  for (const secret of [code, issued.accessToken, issued.refreshToken, refreshed.accessToken, refreshed.refreshToken]) {
    assert.equal(stored.includes(secret), false, "raw token stored");
  }
  assert.ok(stored.includes(sha256(issued.accessToken)));
  assert.ok(stored.includes(sha256(issued.refreshToken)));
  const indexes = second.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'oauth_provider_%'"
  ).all().map(row => row.name);
  for (const name of ["oauth_provider_codes_expires", "oauth_provider_access_tokens_expires",
    "oauth_provider_access_tokens_family", "oauth_provider_access_tokens_user",
    "oauth_provider_refresh_tokens_expires", "oauth_provider_refresh_tokens_family",
    "oauth_provider_clients_expires"]) {
    assert.ok(indexes.includes(name), name);
  }
});

test("expired tokens are rejected and a bounded prune removes them", t => {
  const file = openDb(t);
  let now = 1_700_000_000_000;
  const { db, provider: oauth } = provider(file, () => now);
  t.after(() => db.close());
  oauth.registerClient(CLIENT);
  const issue = () => oauth.issueCode({
    clientId: CLIENT.clientId, userId: "user-1", redirectUri: CLIENT.redirectUris[0],
    scopes: ["chat:read"], codeChallenge: challengeFor(VERIFIER)
  });
  const tokens = oauth.exchangeCode({
    code: issue().code, clientId: CLIENT.clientId, redirectUri: CLIENT.redirectUris[0], codeVerifier: VERIFIER
  });
  const expiredCode = issue();
  issue();
  issue();
  now += 61 * 60 * 1000;
  assert.throws(() => oauth.exchangeCode({
    code: expiredCode.code, clientId: CLIENT.clientId, redirectUri: CLIENT.redirectUris[0], codeVerifier: VERIFIER
  }), /expired/);
  assert.equal(oauth.verifyAccessToken(tokens.accessToken), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM oauth_provider_access_tokens").get().n, 0);
  const before = db.prepare("SELECT count(*) AS n FROM oauth_provider_codes").get().n;
  assert.ok(before >= 2);
  const pruned = pruneOAuthProvider(db, { now, limit: 1 });
  assert.equal(pruned.pruned, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM oauth_provider_codes").get().n, before - 1);
  assert.ok(pruneOAuthProvider(db, { now, limit: 100 }).pruned >= 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM oauth_provider_codes").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM oauth_provider_clients").get().n, 1, "the client has not expired");
});

test("opening a room database does not create oauth tables", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-oauth-lazy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='oauth_provider_clients'").get(), undefined);
  const oauth = createOAuthProvider({ db: store.db, clock: () => store.now() });
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='oauth_provider_clients'").get(), undefined);
  oauth.registerClient(CLIENT);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_provider_clients'").get().name,
    "oauth_provider_clients");
});

const HTTP_CLIENT = { clientId: "muse-durable", name: "Muse Durable", redirectUris: ["https://muse.ai/callback"] };
const HTTP_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

test("an OAuth refresh token from one server works on the next server over the same database", async t => {
  const fixture = createAcceptanceFixture();
  t.after(() => fixture.store.close());
  const sent = [];
  const start = async () => {
    const server = createRoomServer({
      store: fixture.store,
      magicLinkMailer: createMagicLinkMailer({ send: async payload => { sent.push(payload); } }),
      connectorClients: [HTTP_CLIENT]
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  const stop = async server => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  const first = await start();
  t.after(() => stop(first));
  const origin = `http://127.0.0.1:${first.address().port}`;
  const slot = await fetch(`${origin}/api/account-session`);
  const slotView = await slot.json();
  const slotToken = /account_session=([A-Za-z0-9_-]{43})/.exec(slot.headers.get("set-cookie") ?? "")[1];
  const post = (path, body, token = slotToken, csrf = slotView.csrf) => fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": "account_session=" + token, "X-CSRF-Token": csrf, Origin: origin },
    body: JSON.stringify(body)
  });
  await post("/api/auth/magic/request", { email: "oauth-durable@example.com" });
  const consumed = await post("/api/auth/magic/consume", {
    email: "oauth-durable@example.com", code: sent.at(-1).code, sessionToken: slotToken, sessionRevision: slotView.sessionRevision
  });
  assert.equal(consumed.status, 201);
  const sessionToken = /account_session=([A-Za-z0-9_-]{43})/.exec(consumed.headers.get("set-cookie") ?? "")[1];
  const session = await consumed.json();
  const authorized = await fetch(`${origin}/oauth/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", "Cookie": "account_session=" + sessionToken, "X-CSRF-Token": session.csrf, Origin: origin },
    body: JSON.stringify({
      decision: "allow", client_id: HTTP_CLIENT.clientId, redirect_uri: HTTP_CLIENT.redirectUris[0],
      scope: "rooms:read", code_challenge: createHash("sha256").update(HTTP_VERIFIER).digest("base64url"),
      code_challenge_method: "S256", state: "stay"
    })
  });
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get("location")).searchParams.get("code");
  const exchanged = await fetch(`${origin}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code", code, client_id: HTTP_CLIENT.clientId,
      redirect_uri: HTTP_CLIENT.redirectUris[0], code_verifier: HTTP_VERIFIER
    })
  });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  await stop(first);

  const second = await start();
  t.after(() => stop(second));
  const again = `http://127.0.0.1:${second.address().port}`;
  const refreshed = await fetch(`${again}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: HTTP_CLIENT.clientId
    })
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.ok(next.access_token);
  assert.notEqual(next.refresh_token, tokens.refresh_token);
});
