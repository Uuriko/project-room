import test from "node:test";
import assert from "node:assert/strict";
import { workStatus } from "../src/work-status.js";
import { ConversationDrafts, DraftRecovery } from "../src/conversation.js";
import { draftCommand } from "../src/client.js";

test("recorded completion stays pending until the current evidence passes its gates", () => {
  const item = { state: "completed", accountableMemberId: "a", verifierMemberId: "v", humanDecisionMakerId: "h", independentVerificationRequired: true, ownerDecisionRequired: true, receipt: { eventId: "new", evidenceVersion: "v2", producerAttribution: "reported", producerId: "a" } };
  assert.equal(workStatus(item).label, "Awaiting verification");
  item.verification = { result: "pass", completionEventId: "old", evidenceVersion: "v1" };
  assert.equal(workStatus(item).owner, "v");
  item.verification = { result: "pass", completionEventId: "new", evidenceVersion: "v2", verifierId: "v", independenceConfirmed: true };
  assert.equal(workStatus(item).label, "Awaiting decision");
  item.decision = { decision: "approved", completionEventId: "new", evidenceVersion: "v2" };
  assert.equal(workStatus(item).label, "Completed");
  item.state = "blocked"; item.blocker = { nextAction: "Repair the result" };
  assert.equal(workStatus(item).next, "Repair the result");
  assert.equal(workStatus(item).label, "Blocked");
});

test("status and terminality preserve producer independence across the client integration", async () => {
  const { terminalWork } = await import("../src/work-status.js");
  const item = { state: "completed", accountableMemberId: "a", verifierMemberId: "v", humanDecisionMakerId: "h", independentVerificationRequired: true, ownerDecisionRequired: true,
    receipt: { eventId: "result", evidenceVersion: "v1", producerAttribution: "unknown", producerId: null },
    verification: { result: "pass", completionEventId: "result", evidenceVersion: "v1", verifierId: "v", independenceConfirmed: false },
    decision: { decision: "approved", completionEventId: "result", evidenceVersion: "v1" } };
  assert.equal(terminalWork(item), false, "an exact-version PASS cannot close work without independent provenance");
  assert.equal(workStatus(item).owner, "a");
  assert.equal(workStatus(item).label, "Producer unknown");
  item.receipt.producerAttribution = "reported"; item.receipt.producerId = "v";
  assert.equal(terminalWork(item), false);
  assert.equal(workStatus(item).label, "Reviewer conflict");
  item.receipt.producerId = "a";
  assert.equal(workStatus(item).label, "Awaiting verification");
  item.verification.independenceConfirmed = true;
  item.verification.verifierId = "other";
  assert.equal(terminalWork(item), false, "a different verifier cannot satisfy the assigned review");
  item.verification.verifierId = "v";
  assert.equal(terminalWork(item), true);
  assert.equal(workStatus(item).label, "Completed");
});

function fixture() {
  const memory = new Map();
  const storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
  let now = 1000;
  const recovery = new DraftRecovery(storage, () => now);
  const state = { members: { a: { active: true } }, messages: [{ id: "thread" }] };
  const drafts = new ConversationDrafts();
  const data = { body: "Keep this", toMemberId: "a", replyToId: "thread" };
  drafts.save("thread", { ...data, pending: draftCommand(null, "message.posted", data) });
  return { recovery, drafts, state, memory, advance: () => { now += 12 * 60 * 60 * 1000; } };
}
test("tab recovery preserves an unchanged retry but isolates room/member and expires", () => {
  const f = fixture();
  f.recovery.write("room/member", f.drafts, "thread");
  const saved = f.recovery.read("room/member", f.state);
  assert.equal(saved.threadId, "thread");
  assert.deepEqual(saved.drafts.get("thread").pending, f.drafts.get("thread").pending);
  assert.equal(f.recovery.read("other/member", f.state), null);
  assert.equal(f.memory.size, 0);
  f.recovery.write("room/member", f.drafts, "thread"); f.advance();
  assert.equal(f.recovery.read("room/member", f.state), null);
});
test("untrusted storage cannot substitute a command and missing targets are not restored", () => {
  const f = fixture(); f.recovery.write("scope", f.drafts, "thread");
  const saved = JSON.parse(f.memory.get(f.recovery.key));
  saved.entries[0][1].pending.contents = '{"type":"member.added"}';
  f.memory.set(f.recovery.key, JSON.stringify(saved));
  assert.equal(f.recovery.read("scope", f.state).drafts.get("thread").pending, null);
  f.state.members.a.active = false;
  assert.equal(f.recovery.read("scope", f.state).drafts.hasText(), false);
  f.memory.set(f.recovery.key, "invalid JSON");
  assert.equal(f.recovery.read("scope", f.state), null);
  const unavailable = new DraftRecovery({ setItem() { throw Error("quota"); } });
  assert.equal(unavailable.write("scope", f.drafts, "thread"), false);
});
