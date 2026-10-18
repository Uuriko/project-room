// Issue #602: the well-known practice room — self-join with chat scope.
//
// Pins the security discipline of the lane:
//   - a verified pri_ identity's chat-scope request (requestedPermissions
//     []) to room "practice" — and only that room — auto-approves inline
//     with exactly the fixed chat set (no elevated permissions);
//   - the same request to any other room never auto-approves;
//   - a request carrying any elevated permission to "practice" stays
//     pending, and a joined member cannot self-escalate (upgrades always
//     require a reviewed decision);
//   - anonymous / unverified callers never reach the practice path
//     (identity + secret proof is enforced by request() before
//     auto-approval is attempted);
//   - the untrusted-public label is real surface copy: room purpose,
//     room charter, the join response, and llms.txt / llms-full.txt.
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
import { memberCan } from "../src/events.js";
import { PRACTICE_ROOM_ID, PRACTICE_ROOM_OWNER_ID, PRACTICE_ROOM_LABEL,
  PRACTICE_CHAT_PERMISSIONS, provisionPracticeRoom } from "../server/practice-room.mjs";
import { llmsTxt, llmsFullTxt } from "../server/agent-discovery.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-practice-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const provisioned = provisionPracticeRoom(store);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const identity = store.identities.create("Practice Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, identity, provisioned };
}

const chatRequest = (identity, requestId) => ({
  identityId: identity.identityId, displayName: "Practice Agent",
  requestedPermissions: [], requestId,
});

test("provisioning creates the labelled practice room, idempotently", t => {
  const { store, provisioned } = setup(t);
  assert.equal(provisioned.created, true);
  assert.equal(provisionPracticeRoom(store).created, false, "second provisioning is a no-op");
  const room = store.room(PRACTICE_ROOM_ID);
  assert.equal(room.state.room.id, "practice");
  assert.equal(room.state.room.title, "Practice Room");
  assert.match(room.state.room.purpose, /Untrusted public practice room/);
  // The label is charter surface too (orient instructions read the charter).
  assert.equal(room.state.room.charter.boundaries, PRACTICE_ROOM_LABEL);
  assert.match(room.state.room.charter.purpose, /Untrusted public practice room/);
  const owner = room.state.members[PRACTICE_ROOM_OWNER_ID];
  assert.ok(owner && owner.active !== false, "system owner member exists");
  assert.ok(owner.permissions.includes("manage_members"), "owner holds membership administration");
  assert.deepEqual([...PRACTICE_CHAT_PERMISSIONS], [], "the fixed chat set is the empty elevated-permission set");
});

test("verified pri_ identity self-joins the practice room with exactly chat scope", t => {
  const { store, requests, identity } = setup(t);
  const joined = requests.request(PRACTICE_ROOM_ID, chatRequest(identity, "ar_practice_join"), identity.secret);
  assert.equal(joined.status, "approved");
  assert.equal(joined.decidedBy, "auto-approve");
  assert.match(joined.decisionNote, /practice room's standing chat-scope rule/);
  assert.equal(joined.memberId, identity.identityId);
  assert.deepEqual([...joined.grantedPermissions], []);
  // The untrusted-public label rides the join response itself.
  const label = joined.next.find(entry => entry.action === "practice-room-rules");
  assert.ok(label, "join response carries the practice-room rules entry");
  assert.match(label.description, /Untrusted public practice room/);
  assert.match(label.description, /no steer, decide, manage_\*/);
  const member = store.room(PRACTICE_ROOM_ID).state.members[identity.identityId];
  assert.ok(member && member.active !== false, "identity is an active member");
  assert.deepEqual(member.permissions, [], "member holds no elevated permissions");
  const link = store.db.prepare(
    "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?")
    .get(PRACTICE_ROOM_ID, identity.identityId);
  assert.equal(link.memberId, identity.identityId);
  // Idempotent retry returns the approval record, not a second membership.
  const retry = requests.request(PRACTICE_ROOM_ID, chatRequest(identity, "ar_practice_join"), identity.secret);
  assert.equal(retry.status, "approved");
  assert.equal(retry.memberId, identity.identityId);
});

test("the same chat-scope request to any other room is never auto-approved", t => {
  const { requests, identity } = setup(t);
  const pending = requests.request("commons", chatRequest(identity, "ar_practice_other_room"), identity.secret);
  assert.equal(pending.status, "pending", "no standing rule on commons: chat scope waits for the owner");
  assert.equal(pending.decidedBy, null);
});

test("a request carrying elevated permissions to the practice room stays pending", t => {
  const { requests, identity } = setup(t);
  for (const [i, permissions] of [["steer"], ["decide"], ["manage_members"], ["accept_work"]].entries()) {
    const pending = requests.request(PRACTICE_ROOM_ID, {
      identityId: identity.identityId, displayName: "Practice Agent",
      requestedPermissions: permissions, requestId: `ar_practice_elevated_${i}`,
    }, identity.secret);
    assert.equal(pending.status, "pending", `${permissions} must not auto-approve`);
    assert.match(pending.pendingNote, /chat scope/, "pending note teaches the chat-scope rule");
  }
});

test("unverified callers never reach the practice path", t => {
  const { store, requests, identity } = setup(t);
  // Wrong secret for a real identity: proof fails before any approval.
  assert.throws(() => requests.request(PRACTICE_ROOM_ID,
    chatRequest(identity, "ar_practice_bad_secret"), "pri_wrong-secret"),
    error => error.status === 401 || /secret|unauthenticated|invalid/i.test(error.message));
  // Unknown identity (never minted): bare 404, same as any other room.
  assert.throws(() => requests.request(PRACTICE_ROOM_ID, {
    identityId: "ai_doesnotexist", displayName: "Ghost", requestedPermissions: [],
    requestId: "ar_practice_ghost",
  }, "pri_whatever"), error => error.status === 404);
  // No secret at all.
  assert.throws(() => requests.request(PRACTICE_ROOM_ID,
    chatRequest(identity, "ar_practice_no_secret"), null));
  const members = Object.keys(store.room(PRACTICE_ROOM_ID).state.members);
  assert.deepEqual(members, [PRACTICE_ROOM_OWNER_ID], "nobody was admitted by the failed attempts");
});

test("joined member can post, read, and advertise — and is refused steer/decide/manage_*", t => {
  const { store, requests, identity } = setup(t);
  requests.request(PRACTICE_ROOM_ID, chatRequest(identity, "ar_practice_member"), identity.secret);
  const state = store.room(PRACTICE_ROOM_ID).state;
  for (const permission of ["steer", "decide", "manage_members", "manage_claims",
    "accept_work", "complete_work", "verify", "write_external", "invite_member"]) {
    assert.equal(memberCan(state, identity.identityId, permission), false, `member must not hold ${permission}`);
  }
  const token = store.issueAccessKey(PRACTICE_ROOM_ID, identity.identityId);
  // Post a message (chat).
  const posted = store.command(token, PRACTICE_ROOM_ID, {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "hello-practice", body: "Hello from the practice room." },
  });
  assert.ok(posted.sequence > 0);
  // Advertise capabilities.
  const advertised = store.command(token, PRACTICE_ROOM_ID, {
    id: randomUUID(), type: "capabilities.advertised",
    data: { capabilities: ["web-research"] },
  });
  assert.ok(advertised.sequence > 0);
  // Read: presence/orient surfaces are member reads; the roster shows the member.
  assert.ok(store.room(PRACTICE_ROOM_ID).state.members[identity.identityId]);
  // Manage: admitting someone else requires manage_members — refused.
  assert.throws(() => store.command(token, PRACTICE_ROOM_ID, {
    id: randomUUID(), type: "member.added",
    data: { memberId: "intruder", displayName: "Intruder", kind: "agent", permissions: [] },
  }), "member.added by a chat-scope member must be refused");
  // Self-escalation: an upgrade request from the joined member stays
  // pending for a reviewed decision — it never auto-approves.
  const upgrade = requests.request(PRACTICE_ROOM_ID, {
    identityId: identity.identityId, displayName: "Practice Agent",
    requestedPermissions: ["steer"], requestId: "ar_practice_upgrade",
  }, identity.secret);
  assert.equal(upgrade.status, "pending", "permission upgrades always require review");
  assert.deepEqual(store.room(PRACTICE_ROOM_ID).state.members[identity.identityId].permissions, []);
});

test("llms.txt and llms-full.txt document the practice room and its label", () => {
  for (const packet of [llmsTxt(), llmsFullTxt()]) {
    assert.match(packet, /## Practice room \(self-join, chat scope\)/);
    assert.ok(packet.includes(PRACTICE_ROOM_LABEL), "packet carries the untrusted-public label verbatim");
    assert.match(packet, /"roomId":"practice"/, "packet shows the self-join call for room practice");
    assert.match(packet, /no steer, decide, manage_\*/, "packet names the excluded permissions");
  }
});
