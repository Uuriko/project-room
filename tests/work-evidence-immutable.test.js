import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
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

test("nor deleted, including by the room owner", t => {
  const room = completedWithRoomText(t);
  for (const actor of ["producer", "owner"]) {
    const error = refusal(() => room.send(actor, T.MESSAGE_DELETED, {
      messageId: "draft-1", expectedMessageRevision: room.message("draft-1").revision ?? 0, reason: "oops"
    }));
    assert.ok(error, `${actor} must be refused`);
    assert.match(error.message, /recorded result/);
  }
  assert.equal(room.message("draft-1").deletedAt, undefined, "no tombstone was written");
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
