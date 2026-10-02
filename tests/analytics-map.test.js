import test from "node:test";
import assert from "node:assert/strict";
import { emptyRoomFacts, mapRoomEvent } from "../server/analytics/map-room-event.mjs";

const AT = "2026-09-30T15:00:00.000Z";
const LEAKS = ["LeakNameZZ", "LeakTitleZZ", "LeakBodyZZ", "LeakPathZZ", "leak@example.com"];

function roomEvent(type, data, extra = {}) {
  return {
    id: extra.id ?? `${type}-1`, type, actorId: extra.actorId ?? "owner", roomId: extra.roomId ?? "alpha",
    at: AT, sequence: extra.sequence ?? 1, data
  };
}

function names(events) {
  return events.map(event => event.name);
}

test("a room event maps to the growth events its data supports, without copying text", () => {
  const facts = emptyRoomFacts();
  facts.memberKind.owner = "human";
  facts.memberKind.agent1 = "agent";
  const created = mapRoomEvent(roomEvent("room.created", {
    roomId: "alpha", ownerId: "owner", title: "LeakTitleZZ", purpose: "leak@example.com",
    kind: "personal", templateId: "tmpl1"
  }), facts);
  assert.deepEqual(names(created), ["room_created", "template_forked"]);
  assert.equal(created[0].actorKind, "human");
  assert.equal(created[0].props.created_via, "template");
  assert.equal(created[0].props.template_id, "tmpl1");
  assert.equal(created[1].referrerArtifactId, "tmpl:tmpl1");

  const invited = mapRoomEvent(roomEvent("member.added", {
    memberId: "human2", displayName: "LeakNameZZ", kind: "human", invitationId: "inv1", invitedByMemberId: "owner"
  }, { id: "join-1", actorId: "owner" }), facts);
  assert.equal(invited[0].name, "invite_accepted");
  assert.equal(invited[0].refMemberId, "owner");
  assert.equal(invited[0].props.invite_kind, "membership");

  const guest = mapRoomEvent(roomEvent("member.added", {
    memberId: "guest-agent-9", displayName: "LeakNameZZ", kind: "agent"
  }, { id: "guest-1", actorId: "owner" }), facts);
  assert.equal(guest.find(event => event.name === "agent_connected").props.connect_path, "guest");

  const again = mapRoomEvent(roomEvent("member.added", {
    memberId: "guest-agent-9", displayName: "LeakNameZZ", kind: "agent"
  }, { id: "guest-2" }), facts);
  assert.deepEqual(again, []);

  const post = mapRoomEvent(roomEvent("message.posted", {
    body: "LeakBodyZZ", title: "LeakTitleZZ"
  }, { id: "post-1", actorId: "agent1" }), facts);
  assert.equal(post[0].name, "agent_first_post");
  assert.equal(post[0].actorKind, "agent");
  assert.deepEqual(mapRoomEvent(roomEvent("message.posted", { body: "again" }, { id: "post-2", actorId: "agent1" }), facts), []);

  const humanPost = mapRoomEvent(roomEvent("message.posted", { body: "LeakBodyZZ" }, { id: "post-h", actorId: "owner" }), facts);
  assert.deepEqual(humanPost, []);

  const claimId = "claim-map";
  const createdClaim = mapRoomEvent(roomEvent("work_claim.updated", {
    workClaim: claimId, action: "created", claimState: "unclaimed", title: "LeakTitleZZ", paths: ["LeakPathZZ"]
  }, { id: "c-created", actorId: "owner" }), facts);
  assert.deepEqual(names(createdClaim), ["claim_created"]);
  assert.equal(createdClaim[0].props.has_files, true);
  assert.equal(createdClaim[0].props.has_pr, false);

  const claimed = mapRoomEvent(roomEvent("work_claim.updated", {
    workClaim: claimId, action: "claimed", claimState: "claimed", title: "LeakTitleZZ", paths: []
  }, { id: "c-claimed", actorId: "agent1" }), facts);
  assert.equal(claimed[0].name, "claim_claimed");
  assert.equal(claimed[0].props.claimer_kind, "agent");

  const merged = mapRoomEvent(roomEvent("work_claim.updated", {
    workClaim: claimId, action: "pr_merged", claimState: "done", title: "LeakTitleZZ", paths: ["LeakPathZZ"],
    pullRequest: { url: "https://github.com/acme/demo/pull/7", outcome: "merged" }
  }, { id: "c-merged", actorId: "agent1" }), facts);
  assert.deepEqual(names(merged), ["pr_linked", "pr_merged", "claim_completed", "receipt_issued"]);
  assert.deepEqual(merged[0].props, { repo: "acme/demo", pr_number: 7 });
  assert.equal(merged.at(-1).props.receipt_kind, "wcr");
  assert.equal(merged.at(-1).props.public, false);

  const access = mapRoomEvent(roomEvent("access.requested", {
    requestId: "req1", identityId: "ai_123", displayName: "LeakNameZZ", note: "LeakBodyZZ", referredBy: "LeakNameZZ"
  }, { id: "access-1", actorId: "ai_123" }), facts);
  assert.equal(access[0].name, "member_invited");
  assert.equal(access[0].props.invite_kind, "access_request");
  assert.equal(access[0].actorKind, "agent");

  const work = mapRoomEvent(roomEvent("work.completed", {
    workItemId: "work1", summary: "LeakBodyZZ", receipt: { eventId: "work-1" }
  }, { id: "work-1", actorId: "agent1" }), facts);
  assert.deepEqual(names(work), ["claim_completed", "receipt_issued"]);
  assert.equal(work[1].props.receipt_kind, "wir");

  const dumped = JSON.stringify([created, invited, guest, post, createdClaim, claimed, merged, access, work]);
  for (const leak of LEAKS) assert.equal(dumped.includes(leak), false, leak);
});
