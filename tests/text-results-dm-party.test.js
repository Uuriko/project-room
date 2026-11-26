import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";

// P2 (John's Tab r204, seq 13000): GET work-result returned the text of a DM
// linked to a work item to every room member. The draft read and the room_text
// receipt read must follow the DM party rule and the history floor.
async function setup(t) {
  const f = createAcceptanceFixture(), workItemId = "test-handoff";
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data, actor = "producer", id = randomUUID()) => f.store.command(f.keys[actor], "commons", { id, type, data });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const mutate = (type, data = {}, actor) => send(type, { workItemId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const input = posted => ({ workItemId, expectedRevision: item().revision, evidenceKind: "room_text",
    evidenceMessageId: posted.event.data.messageId, evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(posted.event.data.body), previousCompletionEventId: item().receipt?.eventId ?? null,
    producerId: "producer", summary: "A DM result", nextAction: "Review the stored text" });
  const members = Object.keys(f.store.room("commons").state.members);
  const guest = members.includes("guest") ? "guest" : members.find(id => id.startsWith("guest-")) ?? "guest";
  return { ...f, workItemId, send, item, mutate, input, guest };
}

const read = (f, token, params = {}) => f.store.workResult(token, "commons", f.workItemId, params);

test("a work-result draft linked to a DM reads only for the DM's parties", async t => {
  const f = await setup(t);
  const dm = f.send(T.MESSAGE_POSTED, { messageId: "dm-evidence", workItemId: f.workItemId, body: "Secret DM result", toMemberId: f.guest });
  const id = dm.event.data.messageId;
  assert.throws(() => read(f, f.keys.reviewer, { draftMessageId: id }), { code: "result_unavailable" });
  assert.equal(read(f, f.keys.guest, { draftMessageId: id }).result.text.body, "Secret DM result");
  assert.equal(read(f, f.keys.producer, { draftMessageId: id }).result.text.body, "Secret DM result");
  // A missing id and a hidden id answer the same 422: no existence oracle.
  assert.throws(() => read(f, f.keys.reviewer, { draftMessageId: "missing-id" }), { code: "result_unavailable" });
});

test("a room_text completion whose evidence is a DM reads only for the DM's parties", async t => {
  const f = await setup(t);
  const dm = f.send(T.MESSAGE_POSTED, { messageId: "dm-evidence-2", workItemId: f.workItemId, body: "Secret DM completion", toMemberId: f.guest });
  f.mutate(T.WORK_STARTED);
  f.mutate(T.WORK_COMPLETED, f.input(dm));
  assert.equal(f.item().receipt.nativeText.messageId, "dm-evidence-2");
  assert.throws(() => read(f, f.keys.reviewer), { code: "result_unavailable" });
  assert.throws(() => read(f, f.keys.reviewer, { completionEventId: f.item().receipt.eventId }), { code: "result_unavailable" });
  assert.equal(read(f, f.keys.guest).result.text.body, "Secret DM completion");
  // The owner is not exempt from the DM party rule (RC-2026-09-19-070).
  assert.throws(() => read(f, f.keys.owner), { code: "result_unavailable" });
});

test("an earlier result only offers an authorized and unwithdrawn replacement", async t => {
  const f = await setup(t);
  const first = f.send(T.MESSAGE_POSTED, {
    messageId: "public-first", workItemId: f.workItemId, body: "First result for the room"
  });
  f.mutate(T.WORK_STARTED);
  const earlier = f.mutate(T.WORK_COMPLETED, f.input(first));
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Submit a correction" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" });
  f.mutate(T.WORK_STARTED);
  const body = "Replacement shared only with the selected party";
  const posted = f.send(T.MESSAGE_POSTED, {
    messageId: "private-replacement", workItemId: f.workItemId, toMemberId: f.guest, body
  });
  const latest = f.mutate(T.WORK_COMPLETED, f.input(posted));
  const readEarlier = key => read(f, key, { completionEventId: earlier.event.id });
  const nonparty = readEarlier(f.keys.reviewer);
  assert.equal(nonparty.workThread.currentResult, null);
  assert.doesNotMatch(JSON.stringify(nonparty), /private-replacement|Replacement shared only/);
  const party = readEarlier(f.keys.guest);
  assert.deepEqual(party.workThread.currentResult, {
    completionEventId: latest.event.id, evidenceVersion: textVersion(body), messageId: posted.event.data.messageId
  });
  assert.doesNotMatch(JSON.stringify(party), /Replacement shared only/);
  assert.equal(read(f, f.keys.guest, { completionEventId: latest.event.id }).result.text.body, body);
  f.send(T.MESSAGE_DELETED, { messageId: posted.event.data.messageId, expectedMessageRevision: 0 });
  assert.equal(readEarlier(f.keys.guest).workThread.currentResult, null);
  assert.equal(read(f, f.keys.guest, { completionEventId: latest.event.id }).result.text.body, null);
});
