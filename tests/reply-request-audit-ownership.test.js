// auditReplyRequests makes the assumption auditCharters and auditWorkHelp both
// made before it: that the room's owner is whoever created it. It builds its
// projected room from room.created alone and never follows
// ownership.transferred, then replays cancellations through the live reducer,
// which authorizes "the requester or the Room owner".
//
// So a request cancelled by an owner who received the room, on behalf of
// someone else, replays against the founding owner and throws. That throw
// leaves auditRecovery, which gates backupRoom for the entire database, and no
// later event repairs it: backups are down permanently with nothing corrupt.
//
// The existing sweep cannot reach this. It needs an ordering (transfer, then
// the new owner cancels a request that is not theirs), not a missing event
// type, and the sweep only cancels a request whose requester is the actor.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";

function roomWithRequest(t) {
  const fixture = createAcceptanceFixture({ dmConsent: true });
  t.after(() => { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const state = () => fixture.store.room("commons").state;
  const send = (actor, type, data) => fixture.store.command(fixture.keys[actor], "commons",
    { id: randomUUID(), type, data: typeof data === "function" ? data() : data });

  // The founding owner asks the producer for a reply, then hands the room to
  // the guest. The cancellation below is the new owner's, on a request that is
  // not theirs, which is exactly the authority a transfer moves.
  send("owner", T.MESSAGE_POSTED, { messageId: "ask-producer", toMemberId: "producer",
    requestKind: "reply", body: "Could you confirm the agenda owner?" });
  const request = () => state().replyRequests["ask-producer"];
  assert.equal(request().requesterId, "owner");
  return { ...fixture, state, send, request };
}

test("a room that changed hands can still audit a request the new owner cancels", t => {
  const f = roomWithRequest(t);
  f.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "guest", reason: "handing over" });
  assert.equal(f.state().room.ownerId, "guest");

  // The live engine allows this: the room owner may cancel anyone's request.
  f.send("guest", T.REPLY_REQUEST_CANCELLED, () => ({
    requestMessageId: "ask-producer", expectedRequestRevision: f.request().revision, reason: "no longer needed"
  }));
  assert.equal(f.request().status, "cancelled", "the room accepted it");
  assert.deepEqual(f.store.room("commons"), f.store.rebuildProjection("commons"), "the projection was never wrong");

  // ...and the replay must reach the same conclusion, or backups are gone.
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test("a member who is neither the requester nor the owner is still refused", t => {
  const f = roomWithRequest(t);
  f.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "guest", reason: "handing over" });

  // Replaying the transfer must move the authority, not remove the check. If
  // the auditor simply stopped comparing the owner it would accept this, which
  // is the opposite bug and a worse one.
  assert.throws(() => f.send("producer", T.REPLY_REQUEST_CANCELLED, () => ({
    requestMessageId: "ask-producer", expectedRequestRevision: f.request().revision, reason: "not mine to cancel"
  })), /Only the requester or Room owner may cancel/);
  assert.equal(f.request().status, "open");
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test("the requester can still cancel their own request after a transfer", t => {
  const f = roomWithRequest(t);
  f.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "guest", reason: "handing over" });
  // The founding owner is an ordinary member now, but it is still their request.
  f.send("owner", T.REPLY_REQUEST_CANCELLED, () => ({
    requestMessageId: "ask-producer", expectedRequestRevision: f.request().revision, reason: "answered elsewhere"
  }));
  assert.equal(f.request().status, "cancelled");
  assert.doesNotThrow(() => auditRecovery(f.store));
});
