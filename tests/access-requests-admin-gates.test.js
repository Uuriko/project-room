import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// QA200-MUT-11 hardening: admin gates on list() and decide() were uncaught by
// the existing suite (mutants weakening them passed all 27 tests). These tests
// pin the gates so a weakened gate turns red.
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-gates-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, ownerToken, identity };
}

function addMember(store, ownerToken, memberId, permissions) {
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId, displayName: memberId, kind: "agent", permissions }
  });
  return store.issueAccessKey("commons", memberId);
}

function pendingRequest(requests, identity, requestId) {
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId
  });
}

function assertAccessDenied(fn) {
  assert.throws(fn, err => err.status === 403 && err.code === "access_denied");
}

test("decide: a non-admin member (accept_work only) cannot deny a request", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  const memberToken = addMember(store, ownerToken, "mut11_denier", ["accept_work"]);
  pendingRequest(requests, identity, "ar_harden_deny");
  // approve still 403s through the downstream membership-permission path, so
  // the admin gate's real coverage comes from the deny path, which has no
  // defense-in-depth. Removing the gate must not let this through.
  assertAccessDenied(() => requests.decide(memberToken, "commons", "ar_harden_deny",
    { decision: "deny", note: "nope" }));
  // The request must remain undecided so the probe leaves no side effects.
  assert.equal(requests.list(ownerToken, "commons").length, 1);
});

test("decide: a non-admin member (accept_work only) cannot approve a request", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  const memberToken = addMember(store, ownerToken, "mut11_approver", ["accept_work"]);
  pendingRequest(requests, identity, "ar_harden_approve");
  assertAccessDenied(() => requests.decide(memberToken, "commons", "ar_harden_approve",
    { decision: "approve" }));
});

test("list: a non-admin member holding steer cannot list requests", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  // steer is an ordinary work permission; it must not substitute for the
  // membership-administration gate on list().
  const steerToken = addMember(store, ownerToken, "mut11_steerer", ["steer"]);
  pendingRequest(requests, identity, "ar_harden_list");
  assertAccessDenied(() => requests.list(steerToken, "commons"));
});
