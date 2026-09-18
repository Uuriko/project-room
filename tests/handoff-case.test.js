// Research slice R2: CASE handoff contract with epistemic labels. The
// validator accepts a valid CASE block, rejects steps with missing or
// unknown epistemic labels, and the handoff journal stores + returns the
// CASE block when present while still working without it (backward compat).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { caseOf, caseVersion, epistemicLabels, validateCase } from "../server/handoff-case.mjs";
import { buildHandoffPacket, inboxHandoffSchema, InboxHandoffJournal } from "../server/inbox-handoff.mjs";

const caseBlock = (overrides = {}) => ({
  customer: { id: "cust:42", auth: "authenticated_via_google" },
  aim: { goal: "Provision a Dasha Compute trial Mac for the customer", urgency: "high" },
  steps: [
    { action: "Confirm the customer has an active trial slot", source: "billing:cust-42", epistemic: "verified_fact" },
    { action: "Customer asked for an M-series Mac in US-East", source: "chat:thread-1#msg-7", epistemic: "customer_statement" },
    { action: "Likely wants GPU memory for an ML demo", source: "heuristic:demo-traffic", epistemic: "ai_inference" },
    { action: "Offer the US-East pool first", source: "playbook:provisioning", epistemic: "recommendation" },
  ],
  escalation: { owner: "owner", trigger: "No Mac online in US-East after 4h of retries" },
  ...overrides,
});
const packetFields = (overrides = {}) => ({
  threadId: "thread:1", channel: "email", sourceIds: ["src-1"],
  sender: { id: "a@example.test", label: "a@example.test" },
  subject: "Kickoff", occurredAt: "2026-09-18T00:00:00.000Z",
  triage: { action: "needs_human", reasons: ["Uncertain intent"] },
  from: "owner", to: "claude",
  ...overrides,
});
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected ${code} but nothing threw`);
};

test("CASE schema accepts a valid block and freezes it with a version", () => {
  const valid = validateCase(caseBlock());
  assert.equal(valid.caseVersion, caseVersion);
  assert.deepEqual(valid.aim, { goal: "Provision a Dasha Compute trial Mac for the customer", urgency: "high" });
  assert.equal(valid.steps.length, 4);
  assert.deepEqual(valid.steps.map(s => s.epistemic), epistemicLabels);
  assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid.customer) && Object.isFrozen(valid.aim)
    && Object.isFrozen(valid.steps) && Object.isFrozen(valid.escalation));
});
test("CASE schema rejects steps missing an epistemic label", () => {
  const missing = caseBlock();
  delete missing.steps[1].epistemic;
  expectCode(() => validateCase(missing), "invalid_handoff_case");
});
test("CASE schema rejects unknown epistemic labels", () => {
  const wrong = caseBlock({ steps: [{ action: "Do the thing", source: "gut", epistemic: "gut_feeling" }] });
  expectCode(() => validateCase(wrong), "invalid_handoff_case");
});
test("CASE schema rejects bad shapes with invalid_handoff_case", () => {
  expectCode(() => validateCase(null), "invalid_handoff_case");
  expectCode(() => validateCase("not a case"), "invalid_handoff_case");
  expectCode(() => validateCase(caseBlock({ steps: [] })), "invalid_handoff_case");
  expectCode(() => validateCase(caseBlock({ customer: { id: "x" } })), "invalid_handoff_case");
  expectCode(() => validateCase(caseBlock({ aim: { goal: "g", urgency: "eventually" } })), "invalid_handoff_case");
  expectCode(() => validateCase(caseBlock({ escalation: { owner: "o" } })), "invalid_handoff_case");
  expectCode(() => validateCase(caseBlock({ extra: true })), "invalid_handoff_case");
});
test("caseOf maps absent to null and present through the validator", () => {
  assert.equal(caseOf(undefined), null);
  assert.equal(caseOf(null), null);
  assert.equal(caseOf(caseBlock()).caseVersion, caseVersion);
});

function journal(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxHandoffSchema);
  const store = { db, transaction: fn => fn(), readTransaction: fn => fn(), now: () => 1729219200000 };
  t.after(() => db.close());
  return new InboxHandoffJournal(store);
}

test("the journal stores and returns the CASE block", t => {
  const j = journal(t);
  const { receipt, duplicate } = j.create("email:abc", packetFields({ case: caseBlock() }), { to: "claude" });
  assert.equal(duplicate, false);
  assert.equal(receipt.packet.case.caseVersion, caseVersion);
  assert.deepEqual(receipt.packet.case.steps.map(s => s.epistemic), epistemicLabels);
  assert.equal(receipt.packet.case.escalation.owner, "owner");
  const [listed] = j.list("email:abc");
  assert.deepEqual(listed.packet.case, receipt.packet.case, "list returns the stored CASE block");
  j.verify();
});
test("the journal rejects a packet whose CASE block carries an unknown label", t => {
  const j = journal(t);
  expectCode(() => j.create("email:abc",
    packetFields({ case: caseBlock({ steps: [{ action: "a", source: "s", epistemic: "rumor" }] }) }),
    { to: "claude" }), "invalid_handoff_case");
  assert.equal(j.list("email:abc").length, 0, "nothing was journaled");
});
test("absent CASE still works (backward compat)", t => {
  const j = journal(t);
  const viaCreate = j.create("email:abc", packetFields({ threadId: "thread:no-case" }), { to: "claude" });
  assert.equal(viaCreate.receipt.packet.case, null);
  const packet = buildHandoffPacket({ ...packetFields(), handoffId: "h-1", createdAt: "2026-09-18T00:00:00.000Z" });
  assert.equal(packet.case, null);
  j.verify();
});
