import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitation-stats-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  for (const id of ["account-a", "account-b", "account-c", "account-d", "account-target"]) store.createAccount(id);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, { method = "GET", data, headers = {} } = {}) =>
    fetch(`${origin}${path}`, { method,
      headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  async function login(accountAccessKey) {
    const bootstrap = await request("/api/account-session");
    const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
    const { csrf, sessionRevision } = await bootstrap.json();
    const response = await request("/api/account-session", {
      method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf },
      data: { accountAccessKey, expectedSessionRevision: sessionRevision }
    });
    assert.equal(response.status, 201);
    const session = await response.json();
    return { Cookie: cookie, "X-Project-Room-Auth": "account",
      "X-Session-Binding": session.sessionBinding, "X-CSRF-Token": session.csrf };
  }
  const ownerHeaders = await login(store.issueAccountAccessKey("account-owner"));
  const targetHeaders = await login(store.issueAccountAccessKey("account-target"));
  return { store, request, origin, login, ownerHeaders, targetHeaders };
}

async function issueInvitation(request, origin, headers, intendedAccountId, intendedMemberId, expiresAt = Date.now() + 3600000) {
  const invitationToken = randomBytes(32).toString("base64url");
  const response = await request("/api/rooms/commons/invitations", {
    method: "POST", headers: { ...headers, Origin: origin },
    data: { requestId: randomUUID(), invitationToken,
      intendedAccountId, intendedMemberId, displayName: "Guest", role: "member",
      expiresAt, expectedIssuerMemberRevision: 0 }
  });
  assert.equal(response.status, 201);
  return { issued: await response.json(), token: invitationToken };
}

test("invite-link analytics aggregate status counts and conversion (round-2 #108)", async t => {
  const { store, request, origin, login, ownerHeaders, targetHeaders } = await fixture(t);

  // Baseline: no invitations yet.
  let stats = await (await request("/api/rooms/commons/invitations", { headers: ownerHeaders })).json();
  assert.deepEqual(stats, { roomId: "commons", issued: 0, pending: 0, accepted: 0, revoked: 0, expired: 0, conversionRate: null });

  // One accepted, one revoked, one expired, one still pending.
  const a = await issueInvitation(request, origin, ownerHeaders, "account-a", "m-a");
  const b = await issueInvitation(request, origin, ownerHeaders, "account-b", "m-b");
  await issueInvitation(request, origin, ownerHeaders, "account-c", "m-c", Date.now() + 100);
  await issueInvitation(request, origin, ownerHeaders, "account-d", "m-d");

  // Accept a with account-a's session.
  const accountA = await login(store.issueAccountAccessKey("account-a"));
  const acceptResponse = await request("/api/invitations/accept", {
    method: "POST", headers: { ...accountA, Origin: origin },
    data: { invitationToken: a.token, redemptionId: randomUUID(), expectedRevision: 0 }
  });
  assert.equal(acceptResponse.status, 201);

  // Revoke b.
  const revoke = await request(`/api/rooms/commons/invitations/${b.issued.invitation.id}/revoke`, {
    method: "POST", headers: { ...ownerHeaders, Origin: origin },
    data: { expectedRevision: 0, reason: "no longer needed" }
  });
  assert.equal(revoke.status, 200);

  await new Promise(resolve => setTimeout(resolve, 150)); // let c expire

  stats = await (await request("/api/rooms/commons/invitations", { headers: ownerHeaders })).json();
  assert.equal(stats.issued, 4);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.revoked, 1);
  assert.equal(stats.expired, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.conversionRate, 33.3); // 1 accepted of 3 decided

  // A member without manage_members cannot read analytics.
  const denied = await request("/api/rooms/commons/invitations", { headers: targetHeaders });
  assert.equal(denied.status, 403);
});
