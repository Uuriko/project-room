import test from "node:test";
import assert from "node:assert/strict";
import { buildResultCard, renderResultCardText, feedbackForAgent, ResultCardError, MAX_STEPS } from "../server/result-card.mjs";
import { createApprovalQueue } from "../server/inbox-approval.mjs";

const agent = { kind: "agent", id: "codex", label: "Codex" };
const human = { kind: "human", id: "potter", label: "Potter" };
const code = (fn, c) => assert.throws(fn, e => e instanceof ResultCardError && e.code === c);

test("outbound card says nothing sent until a send is recorded", () => {
  const card = buildResultCard({ title: "Camp follow-up", steps: [{ label: "Drafted" }, { label: "Copy check" }, { label: "Approve", status: "waiting", waitingOn: "Kate" }] });
  assert.equal(card.sent, "Nothing sent yet");
  assert.equal(card.waitingOn, "Kate");
  assert.equal(card.state, "waiting");
  assert.deepEqual([...card.actions], ["approve", "reject"]);
  assert.equal(card.rejectRequiresReason, true);
  const sent = buildResultCard({ title: "x", steps: [{ label: "Sent" }], sentAt: 0 });
  assert.match(sent.sent, /^Sent 1970/);
  assert.equal(buildResultCard({ title: "x", outbound: false }).sent, null);
});

test("pending approval waits on the owner; edits wait on the agent", () => {
  const q = createApprovalQueue({ clock: () => 1, id: () => "p1" });
  const p = q.propose("thread:1", { draft: { body: "hi" }, byAgent: agent, channel: "email" });
  const card = buildResultCard({ title: "Reply", approval: p });
  assert.equal(card.waitingOn, "owner");
  assert.deepEqual([...card.actions], ["approve", "request_edits", "reject"]);
  const e = q.requestEdits("p1", { by: human, edits: "shorter" });
  assert.equal(buildResultCard({ title: "Reply", approval: e }).waitingOn, "agent");
  assert.equal(feedbackForAgent(e).text, "Edits requested: shorter");
});

test("reject reason is fed back to the agent", () => {
  const q = createApprovalQueue({ clock: () => 1, id: () => "p2" });
  q.propose("thread:1", { draft: { body: "hi" }, byAgent: agent, channel: "email" });
  const r = q.reject("p2", { by: human, reason: "Keep bios under 50 words" });
  const fb = feedbackForAgent(r);
  assert.equal(fb.kind, "rejected");
  assert.equal(fb.reason, "Keep bios under 50 words");
  assert.equal(fb.suggestCorrection, true);
  assert.equal(buildResultCard({ title: "x", approval: r }).state, "rejected");
});

test("failed step marks the card failed; validation", () => {
  assert.equal(buildResultCard({ title: "x", steps: [{ label: "a", status: "failed" }] }).state, "failed");
  code(() => buildResultCard({ title: "" }), "card_invalid");
  code(() => buildResultCard({ title: "x", steps: [{ label: "a", status: "nope" }] }), "card_invalid");
  code(() => buildResultCard({ title: "x", steps: [{ label: "a", status: "waiting" }] }), "card_invalid");
  code(() => buildResultCard({ title: "x", steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ label: "s" })) }), "card_invalid");
});

test("text rendering lists steps and send state", () => {
  const t = renderResultCardText(buildResultCard({ title: "Dispute", steps: [{ label: "Evidence attached" }, { label: "Submit", status: "waiting", waitingOn: "you" }] }));
  assert.equal(t, "Dispute\n[x] Evidence attached\n[ ] Submit - waiting on you\nWaiting on: you\nNothing sent yet");
});
