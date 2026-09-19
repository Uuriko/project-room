import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { verifyWorkResult } from "../src/work-packet.js";
import { auditRecovery } from "../server/recovery.mjs";

// When work completes with room_text evidence, the receipt names a message and
// src/work-packet.js calls that message the artifact: "Text is never normalized
// here: the immutable stored message is the artifact." Nothing enforced it.
//
// An edit was accepted, and then, all at once: server/text-results.mjs
// storedText requires the posted body to still equal the stored one, so
// GET work-result answered 422 result_unavailable for that item forever while
// the item went on reporting state: completed with an evidenceVersion hash
// matching nothing retrievable; and auditTextResults failed, which takes
// backupRoom down for the whole database, not just that room.

const WORK_ITEM = "test-handoff";

function completedWithRoomText(t) {
  const fixture = createAcceptanceFixture();
  t.after(() => { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => fixture.store.command(fixture.keys[actor], "commons", { id: randomUUID(), type, data });
  const item = () => fixture.store.room("commons").state.workItems[WORK_ITEM];
  const message = id => fixture.store.room("commons").state.messages.find(entry => entry.id === id);

  send("producer", T.WORK_ACCEPTED, { workItemId: WORK_ITEM, expectedRevision: item().revision });
  const posted = send("producer", T.MESSAGE_POSTED, { messageId: "draft-1", workItemId: WORK_ITEM, body: "The agenda is owned by Potter." });
  send("producer", T.WORK_COMPLETED, {
    workItemId: WORK_ITEM, expectedRevision: item().revision, evidenceKind: "room_text",
    evidenceMessageId: "draft-1", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(posted.event.data.body), previousCompletionEventId: null,
    producerId: "producer", summary: "Exact room result", nextAction: "Review the stored text"
  });
  return { ...fixture, send, item, message };
}

const refusal = call => {
  try { call(); } catch (error) { return error; }
  return null;
};

test("a message recorded as a work result cannot be edited", t => {
  const room = completedWithRoomText(t);
  assert.ok(room.item().receipt.nativeText, "the fixture really bound the message as evidence");

  const error = refusal(() => room.send("producer", T.MESSAGE_EDITED, {
    messageId: "draft-1", body: "The agenda is owned by nobody at all.", expectedMessageRevision: room.message("draft-1").revision ?? 0
  }));
  assert.ok(error, "the edit must be refused, not accepted and then broken");
  assert.match(error.message, /recorded result/);
  assert.equal(room.message("draft-1").body, "The agenda is owned by Potter.", "the artifact is unchanged");
});

// Deletion is a different question from editing. Refusing it too would leave
// the room with no way at all to take down text that names a private person or
// is otherwise harmful, for as long as a work item points at it - and there is
// no other removal path: moderation reports and mutes, it does not remove. So
// deletion stays available and carries the consequence with it.
test("but it can be deleted, and the receipt says its text was withdrawn", t => {
  const room = completedWithRoomText(t);
  const before = structuredClone(room.item().receipt);

  room.send("owner", T.MESSAGE_DELETED, {
    messageId: "draft-1", expectedMessageRevision: room.message("draft-1").revision ?? 0, reason: "names a private person"
  });

  assert.equal(room.message("draft-1").body, null, "the room no longer shows the text");
  const receipt = room.item().receipt;
  assert.equal(receipt.nativeText.withdrawnBy, "owner");
  assert.equal(receipt.nativeText.withdrawnAt, room.message("draft-1").deletedAt);
  const { withdrawnAt, withdrawnBy, ...nativeText } = receipt.nativeText;
  assert.deepEqual({ ...receipt, nativeText }, before,
    "a withdrawal adds a fact; it never rewrites what the receipt already claimed");
  assert.equal(receipt.evidenceVersion, before.evidenceVersion,
    "including the hash a verifier signed off against, which is what makes the withdrawal legible");
});

test("a withdrawal leaves the work item readable and the database backup-able", t => {
  const room = completedWithRoomText(t);
  room.send("owner", T.MESSAGE_DELETED, { messageId: "draft-1", expectedMessageRevision: 0, reason: "harmful" });

  const { result } = room.store.workResult(room.keys.producer, "commons", WORK_ITEM);
  assert.equal(result.text.body, null, "the withdrawn text is served to nobody");
  assert.equal(result.text.withdrawnBy, "owner");
  assert.equal(result.text.evidenceVersion, result.receipt.evidenceVersion,
    "the hash still describes exactly what was reported and verified");
  assert.equal(room.item().state, "completed", "withdrawing the text does not un-complete the work");
  // Both of these are the failure this file exists for: a read path that
  // answers 422 forever, and an audit that takes backupRoom down for every
  // room in the database rather than only this one.
  assert.doesNotThrow(() => auditRecovery(room.store), "recovery survives a withdrawal");
});

test("the audit replays the withdrawal instead of believing the projection", t => {
  // The bug class: an auditor that does not implement an event compares its
  // replay against the live projection, disagrees, and fails permanently. The
  // mirror image is an auditor that accepts whatever is stored, which checks
  // nothing. A stored withdrawal that the log does not justify must be caught.
  const room = completedWithRoomText(t);
  room.send("owner", T.MESSAGE_DELETED, { messageId: "draft-1", expectedMessageRevision: 0, reason: "harmful" });
  assert.doesNotThrow(() => auditRecovery(room.store));

  const row = room.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
  const state = JSON.parse(row.projection);
  state.workItems[WORK_ITEM].receipt.nativeText.withdrawnBy = "reviewer";
  room.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
  assert.throws(() => auditRecovery(room.store), "a withdrawal attributed to the wrong member is not a replay of the log");
});

test("withdrawn text cannot be chosen as evidence for a new completion", t => {
  const room = completedWithRoomText(t);
  const first = room.item().receipt;
  room.send("owner", T.MESSAGE_DELETED, { messageId: "draft-1", expectedMessageRevision: 0, reason: "harmful" });
  room.send("reviewer", T.VERIFICATION_RECORDED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, result: "fail",
    completionEventId: first.eventId, evidenceVersion: first.evidenceVersion,
    summary: "The text was withdrawn.", nextAction: "Repost"
  });
  room.send("producer", T.WORK_BLOCKER_RESOLVED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, resolution: "Reposting."
  });
  const error = refusal(() => room.send("producer", T.WORK_COMPLETED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, evidenceKind: "room_text",
    evidenceMessageId: "draft-1", evidenceMessageEventId: room.item().receipt?.nativeText?.messageEventId ?? first.nativeText.messageEventId,
    evidenceVersion: first.evidenceVersion, previousCompletionEventId: first.eventId,
    producerId: "producer", summary: "Reusing withdrawn text", nextAction: "Review"
  }));
  assert.ok(error, "a tombstone is not a result");
  assert.match(error.message, /well-formed message/);
});

test("the result stays readable and the room stays backup-able after a refused edit", t => {
  const room = completedWithRoomText(t);
  const before = room.store.workResult(room.keys.producer, "commons", WORK_ITEM).result.text.body;

  refusal(() => room.send("producer", T.MESSAGE_EDITED, { messageId: "draft-1", body: "rewritten", expectedMessageRevision: 0 }));

  // Both of these used to break permanently the moment that edit landed.
  assert.equal(room.store.workResult(room.keys.producer, "commons", WORK_ITEM).result.text.body, before);
  assert.doesNotThrow(() => auditRecovery(room.store), "a refused edit leaves recovery intact");
});

test("the guard is not over-broad: ordinary messages stay editable", t => {
  const room = completedWithRoomText(t);
  room.send("producer", T.MESSAGE_POSTED, { messageId: "chat-1", body: "unrelated chatter" });

  room.send("producer", T.MESSAGE_EDITED, { messageId: "chat-1", body: "unrelated chatter, fixed", expectedMessageRevision: 0 });
  assert.equal(room.message("chat-1").body, "unrelated chatter, fixed");

  room.send("producer", T.MESSAGE_DELETED, { messageId: "chat-1", expectedMessageRevision: 1, reason: "tidy" });
  assert.equal(room.message("chat-1").body, null, "deletion still works where nothing depends on the text");
});

test("a work-linked message that is not yet anyone's evidence stays editable", t => {
  const room = completedWithRoomText(t);
  // Drafts are meant to be revised, and auditTextResults only walks completed
  // work carrying room_text evidence, so the guard must not reach this far.
  room.send("producer", T.MESSAGE_POSTED, { messageId: "draft-2", workItemId: WORK_ITEM, body: "a later attempt" });
  room.send("producer", T.MESSAGE_EDITED, { messageId: "draft-2", body: "a better later attempt", expectedMessageRevision: 0 });
  assert.equal(room.message("draft-2").body, "a better later attempt");
});

test("evidence from a superseded receipt is protected too", t => {
  const room = completedWithRoomText(t);
  const first = room.item().receipt;

  // Get back to a completable state the way the product does: the verifier
  // fails the check, the accountable member resolves the blocker, and a second
  // completion pushes the first receipt into receiptHistory - where
  // auditTextResults still walks it, so its message still has to hold.
  room.send("reviewer", T.VERIFICATION_RECORDED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, result: "fail",
    completionEventId: first.eventId, evidenceVersion: first.evidenceVersion,
    summary: "The agenda names the wrong owner.", nextAction: "Repost the agenda"
  });
  room.send("producer", T.WORK_BLOCKER_RESOLVED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, resolution: "Reposted with the right owner."
  });
  const second = room.send("producer", T.MESSAGE_POSTED, { messageId: "draft-3", workItemId: WORK_ITEM, body: "A corrected agenda." });
  room.send("producer", T.WORK_COMPLETED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, evidenceKind: "room_text",
    evidenceMessageId: "draft-3", evidenceMessageEventId: second.event.id,
    evidenceVersion: textVersion(second.event.data.body), previousCompletionEventId: first.eventId,
    producerId: "producer", summary: "Corrected room result", nextAction: "Review the stored text"
  });

  assert.ok(room.item().receiptHistory.some(receipt => receipt?.nativeText?.messageId === "draft-1"),
    "the first receipt moved to history");

  // Both the current evidence and the superseded evidence are protected.
  for (const messageId of ["draft-1", "draft-3"]) {
    const error = refusal(() => room.send("producer", T.MESSAGE_EDITED, { messageId, body: "tampered", expectedMessageRevision: 0 }));
    assert.ok(error, `${messageId} must still be protected`);
    assert.match(error.message, /recorded result/);
  }
  assert.doesNotThrow(() => auditRecovery(room.store));
});

test("a superseded receipt's text can be withdrawn too, and the audit follows it", t => {
  const room = completedWithRoomText(t);
  const first = room.item().receipt;
  room.send("reviewer", T.VERIFICATION_RECORDED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, result: "fail",
    completionEventId: first.eventId, evidenceVersion: first.evidenceVersion,
    summary: "The agenda names the wrong owner.", nextAction: "Repost the agenda"
  });
  room.send("producer", T.WORK_BLOCKER_RESOLVED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, resolution: "Reposted with the right owner."
  });
  const second = room.send("producer", T.MESSAGE_POSTED, { messageId: "draft-3", workItemId: WORK_ITEM, body: "A corrected agenda." });
  room.send("producer", T.WORK_COMPLETED, {
    workItemId: WORK_ITEM, expectedRevision: room.item().revision, evidenceKind: "room_text",
    evidenceMessageId: "draft-3", evidenceMessageEventId: second.event.id,
    evidenceVersion: textVersion(second.event.data.body), previousCompletionEventId: first.eventId,
    producerId: "producer", summary: "Corrected room result", nextAction: "Review the stored text"
  });

  // The harmful text is in the superseded receipt, which is exactly the case
  // where nobody is looking: the work item has moved on and the room still
  // shows the message.
  room.send("owner", T.MESSAGE_DELETED, { messageId: "draft-1", expectedMessageRevision: 0, reason: "names a private person" });

  const historical = room.item().receiptHistory.find(receipt => receipt?.nativeText?.messageId === "draft-1");
  assert.equal(historical.nativeText.withdrawnBy, "owner");
  assert.equal(room.item().receipt.nativeText.withdrawnAt, undefined, "the current result is untouched");
  assert.equal(room.store.workResult(room.keys.producer, "commons", WORK_ITEM).result.text.body, "A corrected agenda.");
  assert.equal(room.store.workResult(room.keys.producer, "commons", WORK_ITEM, { completionEventId: first.eventId }).result.text.body, null);
  assert.doesNotThrow(() => auditRecovery(room.store));
});

test("the client verifier reads a withdrawal as a withdrawal, not as a tampered answer", async t => {
  const room = completedWithRoomText(t);
  const receipt = room.item().receipt;
  room.send("owner", T.MESSAGE_DELETED, { messageId: "draft-1", expectedMessageRevision: 0, reason: "harmful" });

  const value = room.store.workResult(room.keys.producer, "commons", WORK_ITEM, { completionEventId: receipt.eventId });
  const verified = await verifyWorkResult(value, { roomId: "commons", workItemId: WORK_ITEM, completionEventId: receipt.eventId });
  assert.equal(verified.result.text.body, null);
  assert.equal(verified.result.text.withdrawnBy, "owner");

  // And it is still a verifier: a served answer that claims the text is intact
  // while the receipt says it was withdrawn, or the reverse, is refused.
  const halfWithdrawn = structuredClone(value);
  delete halfWithdrawn.result.receipt.nativeText.withdrawnAt;
  delete halfWithdrawn.result.receipt.nativeText.withdrawnBy;
  await assert.rejects(verifyWorkResult(halfWithdrawn, { roomId: "commons", workItemId: WORK_ITEM, completionEventId: receipt.eventId }));

  const forged = structuredClone(value);
  forged.result.text.body = "The agenda is owned by Potter.";
  delete forged.result.text.withdrawnAt;
  delete forged.result.text.withdrawnBy;
  await assert.rejects(verifyWorkResult(forged, { roomId: "commons", workItemId: WORK_ITEM, completionEventId: receipt.eventId }),
    "putting the text back does not make it un-withdrawn");
});
