import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const token = () => randomBytes(32).toString("base64url");

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitation-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.createAccount("account-target");
  store.createAccount("account-other");
  const accountKeys = {
    owner: store.issueAccountAccessKey("account-owner"),
    target: store.issueAccountAccessKey("account-target"),
    other: store.issueAccountAccessKey("account-other")
  };

  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (path, { method = "GET", data, headers = {} } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, accountKeys };
}

function accountCookie(response) {
  const value = response.headers.get("set-cookie");
  assert.match(value, /^account_session=[A-Za-z0-9_-]{43};/);
  assert.match(value, /; HttpOnly;/);
  assert.match(value, /; SameSite=Strict;/);
  return value.split(";", 1)[0];
}

async function errorCode(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  return body;
}

async function loginAccount(request, origin, accountAccessKey) {
  const bootstrapResponse = await request("/api/account-session");
  assert.equal(bootstrapResponse.status, 200);
  const cookie = accountCookie(bootstrapResponse);
  const bootstrap = await bootstrapResponse.json();
  const response = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey, expectedSessionRevision: bootstrap.sessionRevision }
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("set-cookie"), null, "login keeps the stable account-session cookie");
  return { cookie, session: await response.json() };
}

function accountRoomHeaders(account, { write = false } = {}) {
  return {
    Cookie: account.cookie,
    "X-Project-Room-Auth": "account",
    "X-Session-Binding": account.session.sessionBinding,
    ...(write ? { "X-CSRF-Token": account.session.csrf } : {})
  };
}

function invitationState(store, invitationId) {
  return {
    roomSequence: store.room("commons").sequence,
    invitation: { ...store.db.prepare(`SELECT revision,status,accepted_at,accepted_by_account_id,redemption_id,joined_event_id
      FROM membership_invitations WHERE id=?`).get(invitationId) },
    auditCount: store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(invitationId).n,
    targetBinding: store.db.prepare("SELECT member_id,account_id FROM member_accounts WHERE room_id='commons' AND account_id='account-target'").get() ?? null,
    targetMember: store.room("commons").state.members["target-member"] ?? null
  };
}

test("account-session bootstrap and login require Origin, CSRF, and revision CAS without replacing the cookie", async t => {
  const { store, origin, request, accountKeys } = await fixture(t);
  const bootstrapResponse = await request("/api/account-session");
  assert.equal(bootstrapResponse.status, 200);
  const cookie = accountCookie(bootstrapResponse);
  const bootstrap = await bootstrapResponse.json();
  assert.deepEqual(Object.keys(bootstrap).sort(), [
    "account", "authenticated", "authenticatedUntil", "csrf", "expiresAt", "sessionBinding", "sessionRevision"
  ]);
  assert.equal(bootstrap.authenticated, false);
  assert.equal(bootstrap.account, null);
  assert.equal(bootstrap.authenticatedUntil, null);
  assert.equal(bootstrap.sessionRevision, 0);
  assert.match(bootstrap.csrf, /^[a-f0-9]{64}$/);
  assert.match(bootstrap.sessionBinding, /^[a-f0-9]{64}$/);

  const restoredResponse = await request("/api/account-session", { headers: { Cookie: cookie } });
  assert.equal(restoredResponse.status, 200);
  assert.equal(restoredResponse.headers.get("set-cookie"), null);
  assert.deepEqual(await restoredResponse.json(), bootstrap);

  const crossOrigin = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://attacker.invalid", "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey: accountKeys.target, expectedSessionRevision: 0 }
  });
  await errorCode(crossOrigin, 403, "origin_denied");
  assert.equal(crossOrigin.headers.get("set-cookie"), null);

  const missingCsrf = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
    data: { accountAccessKey: accountKeys.target, expectedSessionRevision: 0 }
  });
  await errorCode(missingCsrf, 403, "csrf_denied");
  assert.equal(missingCsrf.headers.get("set-cookie"), null);

  const stale = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey: accountKeys.target, expectedSessionRevision: 1 }
  });
  await errorCode(stale, 409, "stale_session_revision");
  assert.equal(stale.headers.get("set-cookie"), null);

  const afterFailures = await request("/api/account-session", { headers: { Cookie: cookie } });
  assert.deepEqual(await afterFailures.json(), bootstrap, "failed login attempts do not advance the session slot");

  const loginResponse = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey: accountKeys.target, expectedSessionRevision: 0 }
  });
  assert.equal(loginResponse.status, 201);
  assert.equal(loginResponse.headers.get("set-cookie"), null, "login reuses the bootstrapped stable slot");
  const loggedIn = await loginResponse.json();
  assert.equal(loggedIn.authenticated, true);
  assert.deepEqual(loggedIn.account, { id: "account-target", revision: 0, authEpoch: 0 });
  assert.equal(loggedIn.sessionRevision, 1);
  assert.notEqual(loggedIn.csrf, bootstrap.csrf);
  assert.notEqual(loggedIn.sessionBinding, bootstrap.sessionBinding);

  const staleReplay = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": loggedIn.csrf },
    data: { accountAccessKey: accountKeys.target, expectedSessionRevision: 0 }
  });
  await errorCode(staleReplay, 409, "stale_session_revision");
  assert.equal(staleReplay.headers.get("set-cookie"), null);

  store.db.prepare(`UPDATE account_session_slots SET account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,
    authenticated_until=NULL,expires_at=0`).run();
  const replacementResponse = await request("/api/account-session", { headers: { Cookie: cookie } });
  assert.equal(replacementResponse.status, 200);
  const replacementCookie = accountCookie(replacementResponse);
  assert.notEqual(replacementCookie, cookie, "an expired stable slot is replaced instead of trapping the browser behind its HttpOnly cookie");
  const replacement = await replacementResponse.json();
  assert.equal(replacement.authenticated, false);
  assert.equal(replacement.sessionRevision, 0);
});

test("invitation preview, account-bound acceptance, Room access, replay, and wrong-account denial hold over HTTP", async t => {
  const { store, origin, request, accountKeys } = await fixture(t);
  const owner = await loginAccount(request, origin, accountKeys.owner);
  const target = await loginAccount(request, origin, accountKeys.target);
  const other = await loginAccount(request, origin, accountKeys.other);
  const invitationToken = token();
  const issueResponse = await request("/api/rooms/commons/invitations", {
    method: "POST",
    headers: { ...accountRoomHeaders(owner, { write: true }), Origin: origin },
    data: {
      requestId: "http-invitation-flow",
      invitationToken,
      intendedAccountId: "account-target",
      intendedMemberId: "target-member",
      displayName: "Target human",
      role: "member",
      expiresAt: Date.now() + 3600000,
      expectedIssuerMemberRevision: 0
    }
  });
  assert.equal(issueResponse.status, 201);
  assert.equal(issueResponse.headers.get("set-cookie"), null);
  const issued = await issueResponse.json();
  assert.equal(issued.duplicate, false);
  const invitationId = issued.invitation.id;

  const beforePreview = invitationState(store, invitationId);
  const previewResponse = await request("/api/invitations/preview", {
    method: "POST",
    headers: { Origin: origin },
    data: { invitationToken }
  });
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("set-cookie"), null);
  const preview = await previewResponse.json();
  assert.deepEqual(Object.keys(preview).sort(), [
    "displayName", "expiresAt", "id", "invitedByDisplayName", "memberId", "permissions", "revision", "role", "roomId", "roomPurpose", "roomTitle", "status"
  ]);
  assert.equal(preview.id, invitationId);
  assert.equal(preview.status, "pending");
  assert.equal(preview.memberId, "target-member");
  assert.deepEqual(preview.permissions, ["accept_work", "complete_work", "verify"]);
  const serializedPreview = JSON.stringify(preview);
  for (const secret of [invitationToken, "account-target", "account-owner", accountKeys.target, accountKeys.owner]) {
    assert.equal(serializedPreview.includes(secret), false, `preview must not expose ${secret === invitationToken ? "the invitation token" : "account secrets"}`);
  }
  assert.deepEqual(invitationState(store, invitationId), beforePreview, "preview is a non-mutating capability check");

  const beforeAccess = await request("/api/rooms/commons", { headers: accountRoomHeaders(target) });
  await errorCode(beforeAccess, 403, "access_denied");
  assert.equal(beforeAccess.headers.get("set-cookie"), null);

  const redemptionId = randomUUID();
  const wrongAccount = await request("/api/invitations/accept", {
    method: "POST",
    headers: { Cookie: other.cookie, Origin: origin, "X-CSRF-Token": other.session.csrf },
    data: { invitationToken, redemptionId, expectedRevision: 0 }
  });
  await errorCode(wrongAccount, 403, "invitation_account_mismatch");
  assert.equal(wrongAccount.headers.get("set-cookie"), null);
  assert.deepEqual(invitationState(store, invitationId), beforePreview, "a wrong account cannot consume or mutate the invitation");

  const acceptResponse = await request("/api/invitations/accept", {
    method: "POST",
    headers: { Cookie: target.cookie, Origin: origin, "X-CSRF-Token": target.session.csrf },
    data: { invitationToken, redemptionId, expectedRevision: 0 }
  });
  assert.equal(acceptResponse.status, 201);
  assert.equal(acceptResponse.headers.get("set-cookie"), null, "acceptance adds membership to the existing account session");
  const accepted = await acceptResponse.json();
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.invitation.status, "accepted");
  assert.equal(accepted.event.actorId, "target-member");
  assert.equal(accepted.session.account.id, "account-target");
  assert.equal(accepted.session.member.id, "target-member");
  assert.equal(accepted.session.sessionBinding, target.session.sessionBinding);
  assert.equal(accepted.session.sessionRevision, target.session.sessionRevision);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id='commons' AND member_id='target-member'").get().n, 0,
    "acceptance creates no replacement Room credential");

  const roomResponse = await request("/api/rooms/commons", { headers: accountRoomHeaders(target) });
  assert.equal(roomResponse.status, 200);
  assert.equal(roomResponse.headers.get("set-cookie"), null);
  const room = await roomResponse.json();
  assert.equal(room.viewerId, "target-member");
  assert.equal(room.viewerAccountId, "account-target");
  assert.equal(room.viewerSessionBinding, target.session.sessionBinding);
  assert.equal(room.viewerSessionRevision, target.session.sessionRevision);

  const beforeReplay = invitationState(store, invitationId);
  const replayResponse = await request("/api/invitations/accept", {
    method: "POST",
    headers: { Cookie: target.cookie, Origin: origin, "X-CSRF-Token": target.session.csrf },
    data: { invitationToken, redemptionId, expectedRevision: 0 }
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(replayResponse.headers.get("set-cookie"), null);
  const replayed = await replayResponse.json();
  assert.equal(replayed.duplicate, true);
  const { duplicate: acceptedDuplicate, ...acceptedReceipt } = accepted;
  const { duplicate: replayDuplicate, ...replayedReceipt } = replayed;
  assert.equal(acceptedDuplicate, false);
  assert.equal(replayDuplicate, true);
  assert.deepEqual(replayedReceipt, acceptedReceipt, "an exact retry returns the original durable receipt");
  assert.deepEqual(invitationState(store, invitationId), beforeReplay, "an exact retry performs no second write");
});
