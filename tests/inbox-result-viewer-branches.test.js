import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { prepareInboxResult } from "../scripts/inbox-result-fixture.mjs";
import { textVersion } from "../server/text-results.mjs";

// R206-1 follow-up (John's Tab r207): the viewer branches of resultRecord
// that the DM-party test does not reach: the adopt path on its own, the
// history floor, and a reader with no active Room membership.
function setup(t, ready = true) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0);
  f.apply = request => f.store.inbox.apply(slot.token, request, session.sessionBinding);
  f.read = () => f.store.inbox.read(slot.token, "note", session.sessionBinding);
  f.apply({ action: "source.save", sourceId: "note", requestId: "source", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Private reply",
      paragraphs: ["Please make the launch reply warmer.", "Private budget: 4200"] } });
  const work = prepareInboxResult(f, slot.token, session.sessionBinding, { ready });
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const record = viewerId => {
    const state = f.store.room("commons").state, item = state.workItems[work.workItemId];
    const share = f.store.inbox.shares(account.id, "note", "commons", Number.MAX_SAFE_INTEGER).find(s => s.receipt.messageId === item.sourceMessageId);
    return f.store.inbox.resultRecord(f.read().source.revision, share, item, state, viewerId);
  };
  const cmd = (type, data) => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type, data });
  return Object.assign(f, work, { record, cmd });
}

test("draft.adopt refuses a DM result even when the request carries a valid resultVersion", t => {
  const f = setup(t, false);
  const dmId = randomUUID(), secret = "Private DM text " + randomUUID();
  const post = f.send("producer", "message.posted", { messageId: dmId, workItemId: f.workItemId,
    packetId: randomUUID(), basisRevision: f.item().revision, toMemberId: "reviewer", body: secret });
  f.mutate("producer", "work.completed", { evidenceKind: "room_text", evidenceMessageId: dmId, evidenceMessageEventId: post.event.id,
    evidenceVersion: textVersion(secret), previousCompletionEventId: f.item().receipt?.eventId ?? null,
    producerId: "producer", summary: "A warmer reply", nextAction: "Review exact text" });
  f.review(); f.decide();
  // resultVersion is a digest of ids the owner can read, so a client can send it
  // without ever being shown the body. The adopt path must check the reader itself.
  const resultVersion = f.record(null).resultVersion;
  assert.ok(resultVersion);
  assert.throws(() => f.apply(f.adoption({ resultVersion })), { code: "stale_inbox_result" });
  assert.equal((f.read().draft?.body ?? "").includes(secret), false);
  // The DM's parties still read the result.
  assert.equal(f.record("reviewer").status, "ready");
  assert.equal(f.record("producer").status, "ready");
});

test("a reader who joined after the evidence under since_join gets no result body", t => {
  const f = setup(t, true);
  f.cmd("room.history_visibility_set", { historyVisibility: "since_join" });
  f.cmd("member.added", { memberId: "late", displayName: "Late", kind: "agent", permissions: [], accountableHumanId: "owner" });
  const late = f.record("late");
  assert.equal(late.status, "no_native_result");
  assert.equal(late.body, undefined);
  assert.equal(f.record("producer").status, "ready");
});

test("a reader with no active Room membership gets no result body", t => {
  const f = setup(t, true);
  assert.equal(f.record("not-a-member").status, "no_native_result");
  const member = f.store.room("commons").state.members.producer;
  f.cmd("member.access_changed", { memberId: "producer", expectedMemberRevision: member.revision, permissions: member.permissions, active: false });
  const inactive = f.record("producer");
  assert.equal(inactive.status, "no_native_result");
  assert.equal(inactive.body, undefined);
  // The audit replay (no viewer) still reproduces the body.
  assert.equal(f.record(null).body, f.body);
});
