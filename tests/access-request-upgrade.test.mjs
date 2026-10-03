import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, REQUEST_TTL_MS } from "../server/access-requests.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// Owner-boundary regression: existing access-request tests cover admission,
// including a join granted before review, but not a request by a current
// member. Real store commands exercise authorization, persistence and replay;
// no production-only seam or permissive service double is needed.
function setup(t, permissions = ["steer"]) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-upgrade-"));
  const filename = join(directory, "room.sqlite");
  let now = Date.now();
  let store = new RoomStore(filename, { now: () => now });
  let requests = new AccessRequests(store);
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner", 30 * 86400000);
  const identity = store.identities.create("Existing Agent");
  const { memberId } = store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, memberId: "existing-agent",
    displayName: "Existing Agent", permissions,
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const fixture = {
    get store() { return store; }, ownerToken, identity, memberId,
    get requests() { return requests; },
    member: () => store.roomAuthority("commons").members[memberId],
    request: (requestId = "ar_upgrade", extra = {}) => fixture.requests.request("commons", {
      identityId: identity.identityId, displayName: "Existing Agent",
      requestedPermissions: ["accept_work", "complete_work"], requestId, ...extra,
    }, identity.secret),
    change: (permissions, active = true) => store.command(ownerToken, "commons", {
      id: randomUUID(), type: "member.access_changed",
      data: { memberId, expectedMemberRevision: fixture.member().revision, permissions, active },
    }),
    reopen: () => { store.close(); store = new RoomStore(filename, { now: () => now }); requests = new AccessRequests(store); },
    advance: milliseconds => { now += milliseconds; },
  };
  return fixture;
}

test("member requests a reviewed, additive upgrade without rejoining or renaming", t => {
  const f = setup(t);
  const original = f.member();
  const requested = f.request("ar_upgrade", { displayName: "Owner" });
  assert.equal(requested.status, "pending");
  assert.equal(requested.displayName, "Existing Agent");
  assert.deepEqual(f.member(), original, "asking must not change membership");
  assert.equal(f.requests.list(f.ownerToken, "commons")[0].requestId, requested.requestId);

  // Request intent must survive a process restart before it is reviewed.
  f.reopen();
  const approved = f.requests.decide(f.ownerToken, "commons", requested.requestId, {
    decision: "approve", permissions: ["accept_work"],
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.memberId, f.memberId);
  assert.deepEqual(approved.grantedPermissions, ["steer", "accept_work"]);
  assert.equal(f.member().revision, original.revision + 1);
  assert.equal(f.member().displayName, original.displayName);
  assert.deepEqual(f.member().permissions, ["steer", "accept_work"]);
  assert.equal(f.store.authenticate(f.identity.secret, "commons").member.id, f.memberId);
  f.reopen();
  assert.deepEqual(f.member().permissions, ["steer", "accept_work"], "approved access survives reopening");
  assert.deepEqual(f.store.rebuildProjection("commons").state.members[f.memberId].permissions,
    ["steer", "accept_work"], "approved access survives event replay");
});

test("an admission auto-approve rule never upgrades an existing member", t => {
  const f = setup(t, []);
  f.requests.setAutoApprove(f.ownerToken, "commons", { permissions: ["accept_work", "complete_work"] });
  const request = f.request();
  assert.equal(request.status, "pending");
  assert.match(request.pendingNote, /review|decision/i);
  assert.deepEqual(f.member().permissions, []);
  assert.equal(f.requests.tryAutoApprove("commons", request.requestId).approved, false);
  const denied = f.requests.decide(f.ownerToken, "commons", request.requestId, { decision: "deny", note: "Not yet" });
  assert.equal(denied.status, "denied");
  assert.deepEqual(f.member().permissions, []);
});

test("upgrade retries do not duplicate or change the request or reapply a reviewed grant", t => {
  const f = setup(t);
  const pending = f.request();
  const sequence = f.store.room("commons").sequence;
  const retry = f.request("ar_upgrade", { requestedPermissions: ["manage_members"] });
  assert.deepEqual(retry.requestedPermissions, pending.requestedPermissions);
  assert.equal(f.store.room("commons").sequence, sequence);
  f.requests.decide(f.ownerToken, "commons", pending.requestId, { decision: "approve" });
  f.change(["steer"]);
  const revision = f.member().revision;
  assert.equal(f.request().status, "approved");
  assert.throws(() => f.requests.decide(f.ownerToken, "commons", pending.requestId, { decision: "approve" }),
    error => error.code === "already_decided");
  assert.equal(f.member().revision, revision);
  assert.deepEqual(f.member().permissions, ["steer"]);
});

test("a no-op membership request still returns already_member", t => {
  const f = setup(t, ["accept_work"]);
  for (const requestedPermissions of [[], ["accept_work"]]) {
    assert.throws(() => f.request(randomUUID(), { requestedPermissions }),
      error => error.status === 409 && error.code === "already_member");
  }
  assert.equal(f.requests.list(f.ownerToken, "commons").length, 0);
});

test("unprivileged and admission-only reviewers cannot approve an upgrade", t => {
  const f = setup(t, []);
  f.request("ar_admin", { requestedPermissions: ["manage_members"] });
  assert.throws(() => f.requests.decide(f.identity.secret, "commons", "ar_admin", { decision: "approve" }),
    error => error.status === 403 && error.code === "access_denied");
  const reviewer = f.store.identities.create("Admission Reviewer");
  f.store.identities.link(f.ownerToken, "commons", { identityId: reviewer.identityId, permissions: [] });
  f.store.delegation.grant(f.ownerToken, "commons", { identityId: reviewer.identityId });
  assert.throws(() => f.requests.decide(reviewer.secret, "commons", "ar_admin", { decision: "approve" }),
    error => error.status === 403 && error.code === "access_denied");
  assert.throws(() => f.requests.decide(reviewer.secret, "commons", "ar_admin", {
    decision: "approve", permissions: ["accept_work"],
  }), error => error.status === 403 && error.code === "access_denied");
  assert.equal(f.requests.status("ar_admin", f.identity.identityId, f.identity.secret).status, "pending");
  assert.deepEqual(f.member().permissions, []);
});

test("changed or withdrawn membership invalidates a pending upgrade", async t => {
  const changes = {
    permissions: f => f.change([]),
    inactive: f => f.change(["steer"], false),
    unlinked: f => f.store.identities.unlink(f.ownerToken, "commons", f.identity.identityId),
    revoked: f => f.store.identities.revoke(f.identity.identityId, f.identity.secret),
    relinked: f => {
      f.store.identities.unlink(f.ownerToken, "commons", f.identity.identityId);
      f.store.identities.link(f.ownerToken, "commons", {
        identityId: f.identity.identityId, memberId: f.memberId,
        permissions: [], settleAccessRequests: false,
      });
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, t => {
      const f = setup(t);
      f.request();
      change(f);
      const member = f.member();
      assert.throws(() => f.requests.decide(f.ownerToken, "commons", "ar_upgrade", { decision: "approve" }),
        error => error.status === 409 && error.code === "stale_membership");
      assert.deepEqual(f.member(), member, "review must not revive or overwrite changed access");
      assert.equal(f.requests.list(f.ownerToken, "commons").find(row => row.requestId === "ar_upgrade").status, "pending");
      assert.equal(f.requests.decide(f.ownerToken, "commons", "ar_upgrade", { decision: "deny" }).status, "denied");
    });
  }
});

test("inactive or revoked memberships cannot file upgrades", async t => {
  for (const mode of ["inactive", "revoked"]) {
    await t.test(mode, t => {
      const f = setup(t);
      if (mode === "inactive") f.change(["steer"], false);
      else f.store.identities.revoke(f.identity.identityId, f.identity.secret);
      assert.throws(() => f.request(), error => mode === "revoked"
        ? error.status === 401 && error.code === "unauthenticated"
        : error.status === 409 && error.code === "stale_membership");
      assert.equal(f.requests.list(f.ownerToken, "commons").length, 0);
    });
  }
});

test("HTTP upgrades and status require current identity-holder proof; admission stays public", async t => {
  const f = setup(t);
  const other = f.store.identities.create("Other Requester");
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const data = { roomId: "commons", identityId: f.identity.identityId, displayName: "Supplied Name",
    requestedPermissions: ["accept_work"], requestId: "ar_http_upgrade" };
  const post = (input, secret) => fetch(`${origin}/api/access-requests`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(input) });
  for (const requestedPermissions of [[], ["steer"], ["accept_work"]]) {
    const response = await post({ ...data, requestedPermissions });
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.ok(!body.includes("Existing Agent"), "anonymous replies do not expose the member name");
  }
  assert.equal((await post(data, other.secret)).status, 401);
  const current = f.store.identities.rotate(f.identity.identityId, f.identity.secret);
  assert.equal((await post(data, f.identity.secret)).status, 401);
  assert.equal((await post(data, current.secret)).status, 201);
  const retry = await post(data);
  assert.equal(retry.status, 401);
  const statusPath = `${origin}/api/access-requests/ar_http_upgrade?identityId=${f.identity.identityId}`;
  for (const secret of [null, other.secret, f.identity.secret]) {
    assert.equal((await fetch(statusPath, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} })).status, 401);
  }
  const status = await fetch(statusPath, { headers: { Authorization: `Bearer ${current.secret}` } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status, "pending");
  assert.equal((await post({ ...data, identityId: other.identityId, displayName: "Other Requester", requestId: "ar_public_join" })).status, 201);
  assert.deepEqual(f.member().permissions, ["steer"]);
});

test("invalid upgrade credentials do not exhaust the holder's request quota", t => {
  const f = setup(t);
  const other = f.store.identities.create("Wrong Holder");
  const requests = new AccessRequests(f.store);
  const input = { identityId: f.identity.identityId, displayName: "Existing Agent", requestedPermissions: ["accept_work"] };
  for (let i = 0; i < 6; i++) {
    assert.throws(() => requests.request("commons", { ...input, requestId: `ar_unauth_${i}` }), error => error.code === "already_member");
    assert.throws(() => requests.request("commons", { ...input, requestId: `ar_wrong_${i}` }, other.secret), error => error.status === 401);
  }
  assert.equal(requests.request("commons", { ...input, requestId: "ar_real_holder" }, f.identity.secret).status, "pending");
});

test("history replacement cannot turn a pending upgrade into fresh admission", t => {
  const f = setup(t);
  const backup = [...f.store.exportEvents(f.ownerToken, "commons")];
  f.request();
  f.store.importEvents(f.ownerToken, "commons", backup);
  assert.throws(() => f.requests.decide(f.ownerToken, "commons", "ar_upgrade", { decision: "approve" }),
    error => error.code === "stale_membership");
  f.store.identities.unlink(f.ownerToken, "commons", f.identity.identityId);
  assert.throws(() => f.requests.decide(f.ownerToken, "commons", "ar_upgrade", { decision: "approve", permissions: ["accept_work"] }),
    error => error.code === "stale_membership");
  assert.equal(f.member().active, false);
  assert.deepEqual(f.member().permissions, ["steer"]);
});

test("upgrade pending state obeys cap, cancellation and expiry", t => {
  const f = setup(t);
  const requests = new AccessRequests(f.store, { rateLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 100 }) });
  const input = { identityId: f.identity.identityId, displayName: "Existing Agent", requestedPermissions: ["accept_work"] };
  for (let i = 0; i < 5; i++) requests.request("commons", { ...input, requestId: `ar_limit_${i}` }, f.identity.secret);
  assert.throws(() => requests.request("commons", { ...input, requestId: "ar_over_limit" }, f.identity.secret), error => error.code === "too_many_requests");
  assert.equal(requests.list(f.ownerToken, "commons").length, 5);
  assert.equal(requests.cancel("ar_limit_0", f.identity.identityId, f.identity.secret).status, "cancelled");
  assert.equal(requests.cancel("ar_limit_0", f.identity.identityId, f.identity.secret).status, "cancelled");
  f.advance(REQUEST_TTL_MS + 1);
  assert.equal(requests.status("ar_limit_1", f.identity.identityId, f.identity.secret).status, "expired");
  assert.equal(requests.list(f.ownerToken, "commons").length, 0);
  assert.equal(requests.list(f.ownerToken, "commons", { status: "expired" }).length, 4);
  assert.deepEqual(f.member().permissions, ["steer"]);
});

test("the pre-upgrade writer rejects pending upgrades even with explicit grants", async t => {
  const f = setup(t);
  // Exercise the actual predecessor decision handler, not a double that
  // repeats its condition. Keep this commit as the rollback compatibility base.
  const previous = execFileSync("git", ["show", "9fa7377bb14632a24b495243083be2adf82e13f2:server/access-requests.mjs"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const source = previous.replace(/from "(\.{1,2}\/[^\"]+)"/g,
    (_, specifier) => `from "${new URL(specifier, new URL("../server/access-requests.mjs", import.meta.url)).href}"`);
  const { AccessRequests: PreviousAccessRequests } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  f.request();
  f.store.identities.unlink(f.ownerToken, "commons", f.identity.identityId);
  const old = new PreviousAccessRequests(f.store);
  for (const options of [{ decision: "approve" }, { decision: "approve", permissions: ["accept_work"] }]) {
    assert.throws(() => old.decide(f.ownerToken, "commons", "ar_upgrade", options),
      error => error.status === 409 && error.code === "already_decided");
  }
  assert.equal(f.member().active, false);
  assert.deepEqual(f.member().permissions, ["steer"]);
  assert.equal(f.requests.decide(f.ownerToken, "commons", "ar_upgrade", { decision: "deny" }).status, "denied");
});
