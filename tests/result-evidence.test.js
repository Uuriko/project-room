// Result evidence guards from src/work-packet.js: body validity, exact
// native-text evidence binding, and handoff proposal context. These exports
// had no test references; the guards they own (evidence must be the exact
// message linked to this work, stale handoffs must be rejected) are the
// contracts under test.
import test from "node:test";
import assert from "node:assert/strict";
import { validResultBody, nativeTextEvidence, proposalContext } from "../src/work-packet.js";

test("validResultBody accepts well-formed text within the size limit", () => {
  assert.equal(validResultBody("the endpoint returned 200"), true);
  assert.equal(validResultBody("x".repeat(4096)), true);
});

test("validResultBody rejects blank, oversized, malformed, and non-string bodies", () => {
  assert.equal(validResultBody(""), false);
  assert.equal(validResultBody("   \n  "), false);
  assert.equal(validResultBody("x".repeat(4097)), false);
  assert.equal(validResultBody(123), false);
  assert.equal(validResultBody(null), false);
  // A lone surrogate is not well-formed text and must never be stored as evidence.
  assert.equal(validResultBody("bad \ud800 text"), false);
});

const SHA = `sha256:${"a".repeat(64)}`;
function evidenceFixture({ message = {}, data = {}, work = {} } = {}) {
  return {
    state: { messages: [{ id: "msg1", workItemId: "work1", body: "the reported result", authorId: "producer1", ...message }] },
    work: { id: "work1", receipt: { eventId: null }, ...work },
    data: { evidenceKind: "room_text", evidenceMessageId: "msg1", evidenceMessageEventId: "evt1",
      previousCompletionEventId: null, producerId: null, evidenceVersion: SHA, ...data },
  };
}

test("nativeTextEvidence binds the exact message linked to this work", () => {
  const { state, work, data } = evidenceFixture();
  assert.deepEqual(nativeTextEvidence(state, work, data), {
    kind: "room_text", messageId: "msg1", messageEventId: "evt1",
    previousCompletionEventId: null, postedById: "producer1", proposal: null,
  });
});

test("nativeTextEvidence rejects evidence from another work item", () => {
  const { state, work, data } = evidenceFixture({ message: { workItemId: "work9" } });
  assert.throws(() => nativeTextEvidence(state, work, data), /explicitly linked to this work/);
});

test("nativeTextEvidence rejects a stale previous completion reference", () => {
  const { state, work, data } = evidenceFixture({ data: { previousCompletionEventId: "evt-old" } });
  assert.throws(() => nativeTextEvidence(state, work, data), /current previous result/);
});

test("nativeTextEvidence rejects non-text evidence and malformed digests", () => {
  const { state, work, data } = evidenceFixture();
  assert.throws(() => nativeTextEvidence(state, work, { ...data, evidenceKind: "external" }), /exact text evidence/);
  assert.throws(() => nativeTextEvidence(state, work, { ...data, evidenceVersion: "sha256:zzz" }), /exact text evidence/);
  assert.throws(() => nativeTextEvidence(state, work, { ...data, evidenceMessageId: "msg-missing" }), /well-formed message/);
});

test("nativeTextEvidence replays a withdrawn message only with allowWithdrawn", () => {
  const deleted = { body: null, deletedAt: "2026-10-01T00:00:00.000Z", deletedBy: "owner1" };
  const withdrawn = evidenceFixture({ message: deleted });
  const evidence = nativeTextEvidence(withdrawn.state, withdrawn.work, withdrawn.data, { allowWithdrawn: true });
  assert.equal(evidence.withdrawnAt, "2026-10-01T00:00:00.000Z");
  assert.equal(evidence.withdrawnBy, "owner1");
  // Without the replay flag a bodyless message is not valid evidence.
  assert.throws(() => nativeTextEvidence(withdrawn.state, withdrawn.work, withdrawn.data), /well-formed message/);
});

test("proposalContext returns null when no handoff reference is present", () => {
  assert.equal(proposalContext({}, { revision: 1 }), null);
  assert.equal(proposalContext({ body: "no ids here" }, { revision: 1 }), null);
});

test("proposalContext builds the manual-unverified context for a current basis", () => {
  const data = { workItemId: "work1", packetId: "pkt1", basisRevision: 3, body: "do the thing" };
  assert.deepEqual(proposalContext(data, { revision: 3 }), {
    packetId: "pkt1", basisRevision: 3, submittedAtRevision: 3, attribution: "manual-unverified",
  });
});

test("proposalContext rejects stale and ahead handoff references", () => {
  const stale = { workItemId: "work1", packetId: "pkt1", basisRevision: 2, body: "old plan" };
  assert.throws(() => proposalContext(stale, { revision: 3 }), /Stale handoff/);
  const ahead = { ...stale, basisRevision: 4 };
  assert.throws(() => proposalContext(ahead, { revision: 3 }), /ahead of this work/);
  // An explicit opt-in still permits the older basis.
  assert.equal(proposalContext({ ...stale, allowOlderBasis: true }, { revision: 3 }).basisRevision, 2);
});

test("proposalContext keeps packet links for a redacted proposal and rejects empty bodies", () => {
  const redacted = { workItemId: "work1", packetId: "pkt1", basisRevision: 3, redacted: true, body: null };
  assert.equal(proposalContext(redacted, { revision: 3 }).packetId, "pkt1");
  assert.throws(() => proposalContext({ workItemId: "work1", packetId: "pkt1", basisRevision: 3, body: "   " }, { revision: 3 }), /1–4000/);
  assert.throws(() => proposalContext({ workItemId: "not a valid id!", packetId: "pkt1", basisRevision: 3, body: "x" }, { revision: 3 }), /Invalid handoff reference/);
});
