import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { prepareInboxResult } from "../scripts/inbox-result-fixture.mjs";
import { textVersion } from "../server/text-results.mjs";

function setup(t, ready = true) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0);
  f.apply = request => f.store.inbox.apply(slot.token, request, session.sessionBinding);
  f.read = () => f.store.inbox.read(slot.token, "note", session.sessionBinding);
  f.source = { action: "source.save", sourceId: "note", requestId: "source", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Private reply",
      paragraphs: ["Please make the launch reply warmer.", "Private budget: 4200"] } };
  f.apply(f.source);
  const work = prepareInboxResult(f, slot.token, session.sessionBinding, { ready });
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return Object.assign(f, work, { slot, session });
}

test("an inbox result whose evidence is a DM between two other members is not readable by the owner", t => {
  const f = setup(t, false);
  assert.equal(f.selected().status, "no_native_result");
  // The producer completes with a DM to the reviewer as room_text evidence.
  const dmId = randomUUID();
  const dmPost = f.send("producer", "message.posted", { messageId: dmId, workItemId: f.workItemId,
    packetId: randomUUID(), basisRevision: f.item().revision, toMemberId: "reviewer", body: f.body });
  f.mutate("producer", "work.completed", { evidenceKind: "room_text", evidenceMessageId: dmId, evidenceMessageEventId: dmPost.event.id,
    evidenceVersion: textVersion(f.body), previousCompletionEventId: f.item().receipt?.eventId ?? null,
    producerId: "producer", summary: "A warmer reply", nextAction: "Review exact text" });
  f.review(); f.decide();
  // The owner is not a party to that DM. No surface hands the owner the text.
  const selected = f.selected();
  assert.equal(selected.status, "no_native_result");
  assert.equal(selected.resultVersion, null);
  assert.equal(selected.body, undefined);
  assert.equal(selected.proof, undefined);
  // resultVersion null fails adoption validation before the stale check.
  assert.throws(() => f.apply(f.adoption()), { code: "invalid_inbox_result" });
  // The DM's parties still read it through the room.
  const reviewerRead = f.store.room("commons").state.messages.find(m => m.id === dmId);
  assert.equal(reviewerRead.toMemberId, "reviewer");
});

test("a normal room-message result stays readable and adoptable", t => {
  const f = setup(t, true);
  const selected = f.selected();
  assert.equal(selected.status, "ready");
  assert.equal(selected.body, f.body);
  const saved = f.apply(f.adoption());
  assert.equal(saved.receipt.body, f.body);
});
