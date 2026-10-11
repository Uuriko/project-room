// WAVE-500 GUILD-2: access-request flow, fail-first probes against the
// standing policy (~/workspace/jill-plugin/access-request-policy.md).
//
// (a) read/chat-only request: approval must grant the agent usable access.
// (b) elevated-permission request: per John's 2026-10-05 order elevated
//     requests are APPROVED with the full grant (no longer held); the
//     standing auto-approve rule may still never mint them.
// (c) unclear identity: held (never auto-approved) with an explanation,
//     never silently dropped.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

const FULL_GRANT = ["accept_work", "complete_work", "steer", "verify", "manage_claims", "write_external"];

function setup(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "project-room-arflow-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, ownerToken };
}

test("(a) read/chat-only approval grants the agent usable access", async t => {
  const { store, requests, ownerToken } = setup(t);
  const identity = store.identities.create("Chat Agent");
  const filed = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Chat Agent",
    requestedPermissions: [], // empty = read/chat access
    note: "wants to pick up work with the other agents",
    requestId: "ar_flow_chat_only"
  });
  assert.equal(filed.status, "pending");

  const decided = requests.decide(ownerToken, "commons", "ar_flow_chat_only", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.ok(decided.memberId, "approval names the new member id");
  assert.deepEqual(decided.grantedPermissions, [], "read/chat approval grants no elevated permissions");

  // The member actually exists in the room, linked to the identity.
  const member = store.room("commons").state.members[decided.memberId];
  assert.ok(member && member.active !== false, "new member is in the room roster");
  assert.equal(member.identityId, identity.identityId);
  assert.deepEqual(member.permissions, []);

  // The agent's own identity secret now authenticates as a member: usable access.
  const auth = store.authenticate(identity.secret, "commons");
  assert.equal(auth.member.id, decided.memberId, "identity secret authenticates as the new member");
});

test("(b) elevated-permission request is approved with the full grant", async t => {
  const { store, requests, ownerToken } = setup(t);
  const identity = store.identities.create("Elevated Agent");
  const filed = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Elevated Agent",
    requestedPermissions: FULL_GRANT,
    note: "joining the swarm to build",
    requestId: "ar_flow_elevated"
  });
  assert.equal(filed.status, "pending");

  const decided = requests.decide(ownerToken, "commons", "ar_flow_elevated",
    { decision: "approve", permissions: FULL_GRANT });
  assert.equal(decided.status, "approved");
  assert.deepEqual([...decided.grantedPermissions].sort(), [...FULL_GRANT].sort(),
    "elevated request is approved with the full grant (2026-10-05 order), not held");

  const member = store.room("commons").state.members[decided.memberId];
  assert.ok(member && member.active !== false, "elevated member is in the room roster");
  assert.deepEqual([...member.permissions].sort(), [...FULL_GRANT].sort());
  const auth = store.authenticate(identity.secret, "commons");
  assert.equal(auth.member.id, decided.memberId, "elevated identity secret authenticates");
});

test("(b) the standing auto-approve rule can never mint elevated permissions", async t => {
  const { requests, ownerToken } = setup(t);
  assert.throws(
    () => requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", "write_external"] }),
    /write_external/,
    "write_external is rejected from the auto-approve config with a teaching error"
  );
  assert.throws(
    () => requests.setAutoApprove(ownerToken, "commons", { permissions: ["decide"] }),
    /decide/,
    "decide is rejected from the auto-approve config with a teaching error"
  );
  assert.equal(requests.getAutoApprove(ownerToken, "commons").autoApprove, null,
    "rejected config leaves no rule behind");
});

test("(c) unclear identity: impersonation-smell name is refused at the door with an explanation", async t => {
  const { store, requests, ownerToken } = setup(t);
  // A known lane member exists; an outside agent then asks to join under a
  // confusing variant of her name.
  const { randomUUID } = await import("node:crypto");
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId: "jill-lane", displayName: "Jill", kind: "agent", permissions: ["accept_work"] }
  });
  const identity = store.identities.create("Outside Agent");
  assert.throws(
    () => requests.request("commons", {
      identityId: identity.identityId,
      displayName: "Jill Owner", // smells like impersonation of the known lane
      requestedPermissions: ["accept_work"],
      requestId: "ar_flow_unclear"
    }),
    err => err.status === 422 && err.code === "display_name_unavailable",
    "a name that reads as the known member's is refused at filing with a teaching error"
  );
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM access_requests WHERE request_id='ar_flow_unclear'").get().n,
    0, "no request row is recorded for the refused name"
  );
});

test("(c) auto-approve holds a mixed-script name with an explanation", async t => {
  const { store, requests, ownerToken } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  const identity = store.identities.create("Outside Agent");
  // Mixed scripts pass the filing-time roster gate but the auto-approve
  // deceptive-name guard holds them for human review, with the reason stated.
  const filed = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Аgent Nova", // leading Cyrillic A, no member to collide with
    requestedPermissions: ["accept_work"],
    requestId: "ar_flow_mixed_script"
  });
  assert.equal(filed.status, "pending", "mixed-script name is held, not auto-approved");
  assert.ok(typeof filed.pendingNote === "string" && filed.pendingNote.length > 0,
    "the hold carries an explanation (never silent)");
  assert.equal(requests.status("ar_flow_mixed_script", identity.identityId).status, "pending");
  assert.ok(!store.room("commons").state.members[identity.identityId],
    "no membership was created while held");
});

test("(c) note-less request with no matching rule stays pending and guided", async t => {  const { store, requests } = setup(t);
  const identity = store.identities.create("Quiet Agent");
  const filed = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Quiet Agent",
    requestedPermissions: [],
    // no note: unclear join purpose -> held for the owner queue
    requestId: "ar_flow_noteless"
  });
  assert.equal(filed.status, "pending");
  assert.ok(Array.isArray(filed.next) && filed.next.length >= 2,
    "pending response carries poll-status + cancel guidance, never silent");
  const poll = requests.status("ar_flow_noteless", identity.identityId);
  assert.equal(poll.status, "pending", "requester can observe the pending decision");
  assert.ok(!store.room("commons").state.members[identity.identityId],
    "no membership while pending");
});
