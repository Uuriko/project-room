// agentCode funnel: the email-verification gate on agent-invite mint must not
// deadlock the funnel on deployments where verification is unachievable.
//
// Root cause: server/agent-invites.mjs create() calls
// accountLogins.assertEmailVerified() unconditionally for account sessions, so
// POST /api/rooms/:roomId/agent-invites answers 403 email_unverified for an
// unverified owner. The sign-in UI itself admits that when email delivery is
// not configured "this account stays unverified" (strings/en.json
// signin.copy.027) — a permanent state, not a nudge. On such deployments the
// gate is a hard funnel deadlock: the owner can create their first room (201,
// room-lifecycle's zero-membership exemption) but can never mint the
// agentCode the funnel needs.
//
// Fix contract: the gate still applies wherever verification is achievable
// (mail configured — see tests/id-sec-http.test.js "an unverified account is
// refused invites and identity mint"), and is skipped only when the
// deployment's mailer is unconfigured, i.e. verification can never complete.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

// No mailer passed to createRoomServer: createMagicLinkMailer() with no send
// function is unconfigured — the deployment can never deliver a code.
async function start(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { f, origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, data, headers = {}) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...headers },
  body: JSON.stringify(data),
});

const cookieToken = res => /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1] ?? null;

// The onboarding-probe agentCode flow: password signup (unverified by
// construction), create first room, mint an agent invite code.
async function funnelMint(t) {
  const { f, origin } = await start(t);
  const n = String(Date.now() % 1000000);
  const slot = f.store.createAccountSessionSlot();
  const signup = await post(origin, "/api/auth/password/signup", {
    email: `funnel-${n}@example.com`,
    password: `funnel-password-${n}-long-enough`,
    sessionToken: slot.token,
    sessionRevision: slot.session.sessionRevision,
  });
  assert.equal(signup.status, 202);
  const token = cookieToken(signup);
  assert.ok(token);
  const session = f.store.authenticateAccountSession(token);
  assert.equal(f.store.accountLogins.emailStatus(session.account.id), "unverified");
  const headers = {
    Cookie: `account_session=${token}`,
    "X-CSRF-Token": session.csrf,
    "X-Session-Binding": session.sessionBinding,
    "X-Project-Room-Auth": "account",
  };
  const roomId = `funnel${n}`;
  const room = await post(origin, "/api/account-rooms", {
    roomId, title: "Funnel", purpose: "Invite mint", kind: "personal", displayName: "Owner",
  }, headers);
  assert.equal(room.status, 201);
  const invite = await post(origin, `/api/rooms/${roomId}/agent-invites`, { profile: "contribute" }, headers);
  return { invite, body: await invite.json(), accountId: session.account.id };
}

test("FUNNEL: unverified owner mints an agentCode when mail is unconfigured", async t => {
  // No mailer passed -> createMagicLinkMailer() with no send -> unconfigured.
  const { invite, body } = await funnelMint(t);
  assert.equal(invite.status, 201, `expected mint to succeed, got ${invite.status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.match(body.code, /^[A-Z]{2}-[A-Z0-9]{16}$/);
  assert.equal(body.profile, "contribute");
});

test("FUNNEL: verified owner still mints when mail is unconfigured (no regression)", async t => {
  const { f, origin } = await start(t);
  const n = String(Date.now() % 1000000);
  const slot = f.store.createAccountSessionSlot();
  const signup = await post(origin, "/api/auth/password/signup", {
    email: `funnel-verified-${n}@example.com`,
    password: `funnel-password-${n}-long-enough`,
    sessionToken: slot.token,
    sessionRevision: slot.session.sessionRevision,
  });
  assert.equal(signup.status, 202);
  const token = cookieToken(signup);
  const session = f.store.authenticateAccountSession(token);
  // Verify out-of-band (as the account-settings UI would once a code exists).
  const issued = f.store.accountLogins.issueEmailVerifyCode({ accountId: session.account.id, email: `funnel-verified-${n}@example.com` });
  f.store.accountLogins.consumeEmailVerifyCode({ accountId: session.account.id, code: issued.code });
  assert.equal(f.store.accountLogins.emailStatus(session.account.id), "verified");
  const headers = {
    Cookie: `account_session=${token}`,
    "X-CSRF-Token": session.csrf,
    "X-Session-Binding": session.sessionBinding,
    "X-Project-Room-Auth": "account",
  };
  const roomId = `funnelv${n}`;
  const room = await post(origin, "/api/account-rooms", {
    roomId, title: "Funnel", purpose: "Invite mint", kind: "personal", displayName: "Owner",
  }, headers);
  assert.equal(room.status, 201);
  const invite = await post(origin, `/api/rooms/${roomId}/agent-invites`, { profile: "chat" }, headers);
  assert.equal(invite.status, 201);
});

// The gate's other boundary — unverified owner + configured mailer still
// 403s — is owned by tests/id-sec-http.test.js ("an unverified account is
// refused invites and identity mint"); not duplicated here.
