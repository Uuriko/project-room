// A024: agent reply drafts with owner approval. Pure lifecycle tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createDraft, decideDraft, markSent, draftStatus, pendingDrafts, DraftError, STATUSES } from "../server/reply-drafts.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DraftError && error.code === code);
const intent = (overrides = {}) => ({ messageId: "m-1", authorAgentId: "quill", body: "Thanks for writing!", channel: "email", connectionId: "graph-1", ...overrides });

test("a draft is born pending_approval and can never send itself", () => {
  const draft = createDraft(intent({ id: "d-1" }));
  assert.equal(draftStatus(draft), "pending_approval");
  assert.equal(draft.id, "d-1");
  assert.ok(Object.isFrozen(draft) && Object.isFrozen(draft.history));
  assert.equal(draft.history[0].type, "created");
  throwsCode(() => markSent(draft, { sentMessageId: "s-1" }), "invalid_draft");
});
test("owner approval opens the send gate", () => {
  const approved = decideDraft(createDraft(intent()), { decision: "approve", decidedBy: "john" });
  assert.equal(draftStatus(approved), "approved");
  assert.equal(approved.decidedBy, "john");
  const sent = markSent(approved, { sentMessageId: "s-9" });
  assert.equal(draftStatus(sent), "sent");
  assert.equal(sent.history.at(-1).sentMessageId, "s-9");
});
test("owner rejection is terminal and carries a reason", () => {
  const rejected = decideDraft(createDraft(intent()), { decision: "reject", decidedBy: "john", reason: "too terse" });
  assert.equal(draftStatus(rejected), "rejected");
  assert.equal(rejected.decisionReason, "too terse");
  throwsCode(() => decideDraft(rejected, { decision: "approve", decidedBy: "john" }), "invalid_draft");
  throwsCode(() => markSent(rejected, { sentMessageId: "s-1" }), "invalid_draft");
});
test("approval cannot be skipped or repeated", () => {
  const draft = createDraft(intent());
  throwsCode(() => decideDraft(draft, { decision: "approve", decidedBy: "" }), "invalid_draft");
  throwsCode(() => decideDraft(draft, { decision: "maybe", decidedBy: "john" }), "invalid_draft");
  throwsCode(() => decideDraft(draft, { decision: "reject", decidedBy: "john" }), "invalid_draft");
  const approved = decideDraft(draft, { decision: "approve", decidedBy: "john" });
  throwsCode(() => decideDraft(approved, { decision: "reject", decidedBy: "john", reason: "x" }), "invalid_draft");
});
test("malformed drafts are refused", () => {
  throwsCode(() => createDraft(intent({ body: "  " })), "invalid_draft");
  throwsCode(() => createDraft(intent({ messageId: "" })), "invalid_draft");
  throwsCode(() => draftStatus({ status: "flying" }), "invalid_draft");
  throwsCode(() => pendingDrafts("nope"), "invalid_draft");
  assert.deepEqual(STATUSES, ["pending_approval", "approved", "rejected", "sent"]);
});
test("pendingDrafts filters the approval queue", () => {
  const drafts = [
    createDraft(intent({ id: "d-1" })),
    decideDraft(createDraft(intent({ id: "d-2" })), { decision: "approve", decidedBy: "john" }),
    decideDraft(createDraft(intent({ id: "d-3" })), { decision: "reject", decidedBy: "john", reason: "no" }),
  ];
  assert.deepEqual(pendingDrafts(drafts).map(d => d.id), ["d-1"]);
});
