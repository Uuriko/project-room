import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildWorkCommand, confirmsAgentCommand, validWorkArguments, workTools, submitWorkAction, workActionRefusal } from "../client/work-actions.mjs";

const identity = { roomId: "commons", memberId: "agent" };
const base = { requestId: "operation", workItemId: "work", expectedRevision: 2 };
const completion = { summary: "Exact artifact", evidenceUrl: "https://example.invalid/artifact", evidenceVersion: "v1", nextAction: "Review this version", checksClaimed: ["one", "two"], producerId: null };
const cases = [
  ["propose_work", "work.proposed", { requestId: "new", workItemId: "new-work", title: "Outcome", definitionOfDone: "Exact result", accountableMemberId: "agent", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: "owner" }],
  ["accept_work", "work.accepted", base], ["start_work", "work.started", { ...base, resolvedBlocker: "Fixed" }],
  ["block_work", "work.blocked", { ...base, reason: "Waiting", nextAction: "Release scope" }],
  ["resolve_blocker", "work.blocker_resolved", { ...base, resolution: "Scope released" }],
  ["record_completion", "work.completed", { ...base, ...completion }],
  ["submit_text_result", "work.completed", { ...base, summary: "Stored text", nextAction: "Review", evidenceMessageId: "message", evidenceMessageEventId: "post",
    evidenceVersion: "sha256:" + "a".repeat(64), producerId: null, previousCompletionEventId: null }],
  ["record_verification", "verification.recorded", { ...base, result: "pass", completionEventId: "completion", evidenceVersion: "v1", summary: "Checked exact bytes" }],
  ["acquire_claim", "claim.acquired", { ...base, repository: "fictional/repo", ref: "main", paths: ["notes/a", "notes/b"], expiresAt: "2030-01-01T00:00:00.000Z" }],
  ["release_claim", "claim.released", base],
  ["renew_claim", "claim.renewed", { ...base, progressMessageId: "progress-1", expiresAt: "2030-01-01T00:00:00.000Z" }],
  ["supersede_work", "work.superseded", { ...base, supersededByWorkItemId: "next-work", reason: "New definition" }],
  ["record_handoff", "work.handoff_recorded", { ...base, doneSummary: "3 of 5 done", nextAction: "Reassign the adapter feed", limitReason: "context window exhausted" }],
  ["clear_halt", "work.halt_cleared", { requestId: "operation", memberId: "agent", haltEventId: "halt-event" }]
];
const receipt = command => ({ sequence: 7, duplicate: false, event: { id: "saved-event", roomId: identity.roomId, actorId: identity.memberId,
  type: command.type, data: structuredClone(command.data), causationId: null, at: "2026-09-08T00:00:00.000Z",
  idempotencyKey: createHash("sha256").update(`${identity.memberId}:${command.id}`).digest("hex") } });

test("every lifecycle descriptor maps exactly to one existing command without new authority or defaults", async () => {
  assert.equal(workTools.length, cases.length);
  for (const [action, type, args] of cases) {
    const name = "room_" + action, { requestId, ...data } = args, sent = [];
    const command = buildWorkCommand(name, args);
    assert.deepEqual(command, { id: requestId, type, data: action === "submit_text_result" ? { ...data, evidenceKind: "room_text" } : data });
    const response = await submitWorkAction({ command: async value => { sent.push(value); return receipt(value); } }, identity, name, args);
    assert.deepEqual(sent, [command]); assert.equal(response.status, "recorded");
    assert.equal(response.appliedRevision, action === "propose_work" ? 0 : action === "clear_halt" ? null : args.expectedRevision + 1);
    assert.equal(response.currentStateVerified, false); assert.equal(response.next.tool, action === "clear_halt" ? "room_read_board" : "room_read_work");
    assert.deepEqual(args, { requestId, ...data });
  }
  assert.throws(() => buildWorkCommand("room_record_owner_decision", base), { code: "invalid_work_action" });
  assert.throws(() => buildWorkCommand("room_add_member", base), { code: "invalid_work_action" });
});

test("strict action inputs preserve null/omission, reject extras and bound command bytes", () => {
  const name = "room_record_completion", args = { ...base, ...completion };
  for (const change of [value => value.expectedRevision = -1, value => value.requestId = "constructor", value => value.token = "secret",
    value => value.checksClaimed = [""], value => value.summary = " ", value => value.producerId = "prototype", value => value.checksClaimed = Array(65).fill("check"),
    value => value.checksClaimed = Array(1)]) {
    const invalid = structuredClone(args); change(invalid); assert.equal(validWorkArguments(name, invalid), false);
  }
  const omitted = { ...args }; delete omitted.producerId;
  assert.equal(Object.hasOwn(buildWorkCommand(name, omitted).data, "producerId"), false);
  assert.equal(buildWorkCommand(name, args).data.producerId, null);
  const large = { ...args, summary: "☀".repeat(4096), checksClaimed: Array(20).fill("a".repeat(512)) };
  assert.equal(validWorkArguments(name, large), true); assert.throws(() => buildWorkCommand(name, large), { code: "work_action_too_large" });
  const built = buildWorkCommand(name, args); args.checksClaimed.reverse(); assert.deepEqual(built.data.checksClaimed, ["one", "two"]);
  const claim = cases.find(([action]) => action === "acquire_claim")[2];
  assert.equal(validWorkArguments("room_acquire_claim", { ...claim, paths: ["a".repeat(512)] }), true);
  assert.equal(validWorkArguments("room_acquire_claim", { ...claim, paths: ["a".repeat(513)] }), false);
});

test("exact receipts bind operation fingerprint, event identity, cause, ordered arrays and omitted fields", () => {
  const command = buildWorkCommand("room_record_completion", { ...base, ...completion });
  assert.equal(confirmsAgentCommand(receipt(command), command, identity), true);
  for (const mutate of [r => r.sequence = 0, r => r.duplicate = "false", r => r.event.id = "", r => r.event.type = "work.accepted",
    r => r.event.actorId = "other", r => r.event.roomId = "other", r => r.event.idempotencyKey = "other-operation",
    r => r.event.causationId = "other", r => r.event.at = "bad time", r => r.event.data.checksClaimed.reverse(),
    r => delete r.event.data.producerId, r => r.event.data.extra = true]) {
    const invalid = receipt(command); mutate(invalid); assert.equal(confirmsAgentCommand(invalid, command, identity), false);
  }
  const reordered = receipt(command); reordered.event.data = Object.fromEntries(Object.entries(reordered.event.data).reverse());
  assert.equal(confirmsAgentCommand(reordered, command, identity), true);
});

test("malformed success stays unconfirmed; historical replay does not assert a current claim", async () => {
  const args = cases.find(([action]) => action === "acquire_claim")[2];
  const unknown = await submitWorkAction({ command: async () => ({}) }, identity, "room_acquire_claim", args);
  assert.equal(unknown.status, "unconfirmed");
  const replay = await submitWorkAction({ command: async command => ({ ...receipt(command), duplicate: true }) }, identity, "room_acquire_claim", args);
  assert.equal(replay.status, "recorded"); assert.equal(replay.duplicate, true); assert.equal(replay.currentStateVerified, false);
  assert.equal(Object.hasOwn(replay, "claim"), false);
});

test("known business refusals have fixed recovery guidance and never echo service text", () => {
  for (const code of ["claim_conflict", "invalid_claim_scope", "idempotency_conflict", "command_rejected", "pilot_limit"]) {
    const response = workActionRefusal({ status: 409, code, message: "PRIVATE SECRET" });
    assert.equal(response.code, code); assert.equal(response.outcome, "this_attempt_refused");
    assert.equal(JSON.stringify(response).includes("PRIVATE SECRET"), false);
  }
  assert.equal(workActionRefusal({ status: 503, code: "private-code" }), null);
  assert.equal(workActionRefusal({ status: 422, code: "unrecognized" }), null);
  const unsigned = workActionRefusal({ status: 422, code: "missing_signed_evidence", message: "PRIVATE SECRET" });
  assert.equal(unsigned.code, "missing_signed_evidence");
  assert.equal(unsigned.outcome, "this_attempt_refused");
  assert.equal(unsigned.reason, "missing_signed_evidence");
  assert.match(unsigned.message, /evidenceKind room_text/);
  assert.match(unsigned.hint, /room_text/);
  assert.ok(unsigned.next.some(step => step.tool === "room_submit_text_result"));
  assert.equal(JSON.stringify(unsigned).includes("PRIVATE SECRET"), false);
});

// Issue #6 A4: a room policy can make independent review and/or an owner
// decision mandatory. The policy is an owner-only room event applied by the
// projection, so no client field can disable a mandatory gate and work recorded
// before a flip keeps exactly what it was recorded with.
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T, replay, roomPolicy } from "../src/events.js";
import { confirmsWorkProposal } from "../src/workflow.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

function policyFixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => { const command = { id: randomUUID(), type, data }; return { command, receipt: f.store.command(f.keys[actor], "commons", command) }; };
  const propose = (actor, workItemId, data) => send(actor, T.WORK_PROPOSED, { workItemId, title: `Outcome ${workItemId}`, definitionOfDone: "Exact result recorded", accountableMemberId: "producer", mode: "read", ...data });
  const setPolicy = (actor, data) => send(actor, T.ROOM_POLICY_SET, data);
  const state = () => f.store.room("commons").state;
  const signEvidence = makeTestSigner(f.store);
  return { ...f, send, propose, setPolicy, state, signEvidence };
}

test("room policy: altered client fields cannot disable the independent gate or the owner decision", t => {
  const f = policyFixture(t);
  assert.deepEqual(roomPolicy(f.state()), { requireIndependentReview: false, requireOwnerDecision: false }, "off is the default");
  f.setPolicy("owner", { requireIndependentReview: true, requireOwnerDecision: true });
  assert.deepEqual(roomPolicy(f.state()), { requireIndependentReview: true, requireOwnerDecision: true });
  assert.equal(f.state().room.policy.revision, 1); assert.equal(f.state().room.policy.setById, "owner");
  // A client that claims neither requirement still records both; the owner is the default decision-maker.
  const { command, receipt } = f.propose("owner", "forced", { independentVerificationRequired: false, ownerDecisionRequired: false, verifierMemberId: "reviewer" });
  const item = f.state().workItems.forced;
  assert.equal(item.independentVerificationRequired, true); assert.equal(item.ownerDecisionRequired, true);
  assert.equal(item.verifierMemberId, "reviewer"); assert.equal(item.humanDecisionMakerId, "owner");
  // The event keeps the client's words and the receipt still confirms the exact command; the projection is the authority.
  assert.equal(receipt.event.data.independentVerificationRequired, false);
  assert.equal(confirmsWorkProposal(receipt, command, "commons", "owner"), true);
  // Without a verifier nothing is recorded and the refusal names the policy.
  assert.throws(() => f.propose("owner", "no-verifier", { independentVerificationRequired: false, ownerDecisionRequired: false }), { status: 422, code: "command_rejected", message: /Room policy requires independent review/ });
  assert.equal(f.state().workItems["no-verifier"], undefined);
  // The gate itself holds downstream: completion without an independent PASS cannot be approved.
  f.send("producer", T.WORK_ACCEPTED, { workItemId: "forced", expectedRevision: 0 });
  f.send("producer", T.WORK_COMPLETED, { workItemId: "forced", expectedRevision: 1, summary: "Done", evidenceUrl: "https://example.invalid/result", evidenceVersion: "v1", nextAction: "Review", producerId: "producer", signedEvidence: f.signEvidence() });
  const completed = f.state().workItems.forced;
  const rationale = f.send("owner", T.MESSAGE_POSTED, { body: "Rationale: attempting to force approval." });
  assert.throws(() => f.send("owner", T.OWNER_DECISION_RECORDED, { workItemId: "forced", expectedRevision: completed.revision, decision: "approved", completionEventId: completed.receipt.eventId, evidenceVersion: "v1", reason: "Looks fine", sourceMessageId: rationale.command.id }), /independent PASS/);
  assert.equal(f.state().workItems.forced.decision, null);
});

test("room policy: a casual message never creates work, with the policy off or on", t => {
  const f = policyFixture(t);
  const count = () => Object.keys(f.state().workItems).length;
  const before = count();
  f.send("owner", T.MESSAGE_POSTED, { body: "Can someone review the agenda and turn it into a task with a reviewer?" });
  assert.equal(count(), before);
  f.setPolicy("owner", { requireIndependentReview: true, requireOwnerDecision: false });
  f.send("owner", T.MESSAGE_POSTED, { body: "Please make this work: review required, owner approval required." });
  assert.equal(count(), before);
  assert.equal(f.state().messages.filter(m => m.body?.includes("turn it into a task") || m.body?.includes("make this work")).length, 2, "conversation is recorded as conversation only");
});

test("room policy: work recorded before a flip keeps its recorded requirements; the flip is event-sourced and replayable", t => {
  const f = policyFixture(t);
  f.propose("owner", "light", { independentVerificationRequired: false, ownerDecisionRequired: false });
  const light = () => f.state().workItems.light;
  assert.deepEqual([light().independentVerificationRequired, light().ownerDecisionRequired, light().humanDecisionMakerId], [false, false, null]);
  f.setPolicy("owner", { requireIndependentReview: true, requireOwnerDecision: true });
  assert.deepEqual([light().independentVerificationRequired, light().ownerDecisionRequired], [false, false], "an earlier item is untouched by a later flip");
  f.propose("owner", "under", { independentVerificationRequired: false, ownerDecisionRequired: false, verifierMemberId: "reviewer" });
  f.setPolicy("owner", { requireIndependentReview: false, requireOwnerDecision: false });
  assert.equal(f.state().room.policy.revision, 2);
  const under = f.state().workItems.under;
  assert.deepEqual([under.independentVerificationRequired, under.ownerDecisionRequired], [true, true], "switching the policy off does not relax recorded work");
  f.propose("owner", "after", { independentVerificationRequired: false, ownerDecisionRequired: false });
  assert.deepEqual([f.state().workItems.after.independentVerificationRequired, f.state().workItems.after.ownerDecisionRequired], [false, false], "off restores the proposer's choice");
  const events = [];
  for (let after = 0; ;) { const page = f.store.eventsAfter(f.keys.owner, "commons", after, 100); events.push(...page.events.map(row => row.event)); if (page.events.length < 100) break; after = page.events.at(-1).sequence; }
  const replayed = replay(events);
  for (const id of ["light", "under", "after"]) assert.deepEqual(replayed.workItems[id], f.state().workItems[id], `replay reproduces ${id}`);
  assert.deepEqual(replayed.room.policy, f.state().room.policy);
});

test("room policy: only the room owner sets it, and the command shape is strict", t => {
  const f = policyFixture(t);
  const on = { requireIndependentReview: true, requireOwnerDecision: true };
  assert.throws(() => f.setPolicy("guest", on), { status: 422, code: "command_rejected", message: /Only the Room owner may set room policy/ });
  assert.throws(() => f.setPolicy("reviewer", on), /Only the Room owner may set room policy/);
  assert.equal(f.state().room.policy, undefined, "a refused policy leaves no trace");
  assert.throws(() => f.setPolicy("owner", { requireIndependentReview: "yes", requireOwnerDecision: true }), { status: 422, code: "invalid_command", message: /Invalid field: requireIndependentReview/ });
  assert.throws(() => f.setPolicy("owner", { ...on, expectedRevision: 0 }), { code: "invalid_command", message: /Unexpected field: expectedRevision/ });
  assert.throws(() => f.setPolicy("owner", { requireIndependentReview: true }), { code: "command_rejected", message: /requireOwnerDecision as true or false/ });
  assert.equal(f.state().room.policy, undefined);
  f.setPolicy("owner", on);
  assert.deepEqual(roomPolicy(f.state()), on);
});
