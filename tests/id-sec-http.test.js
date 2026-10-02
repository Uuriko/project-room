// Verified email, uniform signup limits, and room-scoped MCP tokens.
// Real HTTP server and store. Fixture addresses only.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const password = n => `fixture-password-${n}-long-enough`;
const email = n => `id-sec-${n}@example.invalid`;

async function start(t, { mailer = null } = {}) {
  const f = createAcceptanceFixture();
  const sent = [];
  const magicLinkMailer = mailer ?? createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  const server = createRoomServer({ store: f.store, magicLinkMailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { f, origin: `http://127.0.0.1:${server.address().port}`, sent };
}

const post = (origin, path, data, headers = {}) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...headers },
  body: JSON.stringify(data)
});

const cookieToken = res => /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1] ?? null;

function credsFrom(store, token) {
  const session = store.authenticateAccountSession(token);
  return {
    session,
    headers: {
      Cookie: `account_session=${token}`,
      "X-CSRF-Token": session.csrf,
      "X-Session-Binding": session.sessionBinding
    }
  };
}

async function openSlot(origin) {
  const res = await fetch(`${origin}/api/account-session`);
  assert.equal(res.status, 200);
  const view = await res.json();
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(token);
  return { token, csrf: view.csrf, revision: view.sessionRevision };
}

test("a later verified sign-in removes an unverified password and records it", async t => {
  const { f, origin, sent } = await start(t);
  const slot = f.store.createAccountSessionSlot();
  const signed = await post(origin, "/api/auth/password/signup", {
    email: email(1), password: password(1), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  });
  assert.equal(signed.status, 202);
  const accountId = f.store.authenticateAccountSession(cookieToken(signed)).account.id;
  assert.equal(f.store.accountLogins.findAccountByVerifiedEmail(email(1)), null);

  const fresh = await openSlot(origin);
  const requested = await post(origin, "/api/auth/magic/request", { email: email(1) }, {
    Cookie: `account_session=${fresh.token}`, "X-CSRF-Token": fresh.csrf
  });
  assert.equal(requested.status, 200);
  const code = sent.find(row => row.purpose !== "email-verify" && row.to === email(1))?.code
    ?? sent.at(-1)?.code;
  assert.equal(typeof code, "string");
  const consumed = await post(origin, "/api/auth/magic/consume", {
    email: email(1), code, sessionToken: fresh.token, sessionRevision: fresh.revision
  }, { Cookie: `account_session=${fresh.token}`, "X-CSRF-Token": fresh.csrf });
  assert.equal(consumed.status, 201);
  const magicToken = cookieToken(consumed);
  const magic = f.store.authenticateAccountSession(magicToken);
  assert.equal(magic.account.id, accountId);

  const loginSlot = f.store.createAccountSessionSlot();
  const login = await post(origin, "/api/auth/password/login", {
    email: email(1), password: password(1), sessionToken: loginSlot.token, sessionRevision: loginSlot.session.sessionRevision
  });
  assert.equal(login.status, 401);
  assert.equal(f.store.accountLogins.findPasswordAccount(email(1)), null);
  const events = f.store.accountLogins.securityEvents(accountId);
  assert.ok(events.some(row => row.type === "account.password_revoked_unverified"));

  const methods = await fetch(`${origin}/api/auth/methods`, { headers: { Cookie: `account_session=${magicToken}` } });
  assert.equal(methods.status, 200);
  const body = await methods.json();
  assert.equal(body.emailVerification.status, "verified");
  assert.equal(body.emailVerification.passwordResetRequired, true);
  assert.equal(body.methods.some(row => row.type === "password"), false);
});

test("an unverified account is refused invites and identity mint", async t => {
  const { f, origin } = await start(t);
  const slot = f.store.createAccountSessionSlot();
  const signed = await post(origin, "/api/auth/password/signup", {
    email: email(2), password: password(2), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  });
  assert.equal(signed.status, 202);
  const { headers } = credsFrom(f.store, cookieToken(signed));
  const room = await post(origin, "/api/account-rooms", {
    roomId: "id-sec-den", title: "Den", purpose: "One room", kind: "personal", displayName: "Owner"
  }, headers);
  assert.equal(room.status, 201);
  const second = await post(origin, "/api/account-rooms", {
    roomId: "id-sec-two", title: "Two", purpose: "Another", kind: "personal", displayName: "Owner"
  }, headers);
  assert.equal(second.status, 403);
  assert.equal((await second.json()).error.code, "email_unverified");

  const invite = await post(origin, "/api/rooms/id-sec-den/agent-invites", { profile: "chat" }, {
    ...headers, "X-Project-Room-Auth": "account"
  });
  assert.equal(invite.status, 403);
  assert.equal((await invite.json()).error.code, "email_unverified");

  const minted = await post(origin, "/api/agent-identities", { displayName: "Unverified mint" }, {
    Cookie: headers.Cookie
  });
  assert.equal(minted.status, 403);
  assert.equal((await minted.json()).error.code, "email_unverified");

  const anon = await post(origin, "/api/agent-identities", { displayName: "Anonymous mint" });
  assert.equal(anon.status, 201);
});

async function mcpServer(t) {
  const directory = mkdtempSync(join(tmpdir(), "id-sec-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

function rpc(origin, method, params, token, userAgent = "project-room-id-sec") {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgent,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
}

test("a room token works on /mcp for its room, expires, and records last use", async t => {
  const { origin, store, rooms } = await mcpServer(t);
  const owner = store.identities.create("MCP owner");
  const created = rooms.create(owner.secret, {
    roomId: "id-sec-mcp", title: "MCP", purpose: "Scoped token", kind: "personal", displayName: "MCP owner"
  });
  const token = created.mcpToken.credential;
  assert.match(token, /^rak_/);
  assert.equal(JSON.stringify(created).includes(owner.secret), false);

  const ok = await rpc(origin, "tools/call", {
    name: "room_check_access", arguments: { roomId: "id-sec-mcp" }
  }, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("deprecation"), null);
  const okBody = await ok.json();
  assert.equal(okBody.result.structuredContent.status, "credential_accepted");
  assert.equal(okBody.result.structuredContent.roomId, "id-sec-mcp");

  const other = await rpc(origin, "tools/call", {
    name: "room_check_access", arguments: { roomId: "other-room" }
  }, token);
  const otherBody = await other.json();
  assert.equal(otherBody.result.isError, true);
  assert.equal(otherBody.result.structuredContent.code, "insufficient_scope");
  assert.equal(otherBody.result.structuredContent.status, 403);

  const listed = await fetch(`${origin}/api/agent-keys`, { headers: { Authorization: `Bearer ${owner.secret}` } });
  assert.equal(listed.status, 200);
  const keys = await listed.json();
  const key = keys.keys.find(row => row.keyId === created.mcpToken.keyId);
  assert.equal(typeof key.lastUsedAt, "number");
  assert.equal(key.lastUsedUa, "project-room-id-sec");
  assert.equal(typeof keys.identityUsage.lastUsedAt, "number");
  assert.equal(keys.identityUsage.lastUsedUa, "project-room-id-sec");
  assert.equal(keys.identityUsage.mcpLegacyUses, 0);

  const legacy = await rpc(origin, "tools/list", undefined, owner.secret, "legacy-host");
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get("deprecation"), "@1798761600");
  assert.match(legacy.headers.get("link") ?? "", /rel="deprecation"/);
  const afterLegacy = store.identities.mcpUsage(owner.identityId);
  assert.ok(afterLegacy.mcpLegacyUses >= 1);
  assert.equal(afterLegacy.lastUsedUa, "legacy-host");

  store.agentPlugin.keys.get(created.mcpToken.keyId).expiresAt = store.now() - 1;
  const expired = await rpc(origin, "tools/call", {
    name: "room_check_access", arguments: { roomId: "id-sec-mcp" }
  }, token);
  assert.equal(expired.status, 401);
});

test("findAccountByVerifiedEmail callers stay on the verified-email contract", () => {
  // Security contract: an unverified email is not proof of ownership.
  // Recovery redeem is the only HTTP caller. adoptVerifiedEmail is the
  // internal adopter. A new caller fails this test.
  const root = new URL("../server/", import.meta.url);
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mjs") && readFileSync(path, "utf8").includes("findAccountByVerifiedEmail")) {
        found.push(path.slice(root.pathname.length));
      }
    }
  };
  walk(root.pathname);
  assert.deepEqual(found.sort(), ["account-login-methods.mjs", "http.mjs"]);
});
