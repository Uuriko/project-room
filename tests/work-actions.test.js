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
  ["record_verification", "verification.recorded", { ...base, result: "pass", completionEventId: "completion", evidenceVersion: "v1", summary: "Checked exact bytes" }],
  ["acquire_claim", "claim.acquired", { ...base, repository: "fictional/repo", ref: "main", paths: ["notes/a", "notes/b"], expiresAt: "2030-01-01T00:00:00.000Z" }],
  ["release_claim", "claim.released", base],
  ["supersede_work", "work.superseded", { ...base, supersededByWorkItemId: "next-work", reason: "New definition" }]
];
const receipt = command => ({ sequence: 7, duplicate: false, event: { id: "saved-event", roomId: identity.roomId, actorId: identity.memberId,
  type: command.type, data: structuredClone(command.data), causationId: null, at: "2026-09-08T00:00:00.000Z",
  idempotencyKey: createHash("sha256").update(`${identity.memberId}:${command.id}`).digest("hex") } });

test("every lifecycle descriptor maps exactly to one existing command without new authority or defaults", async () => {
  assert.equal(workTools.length, cases.length);
  for (const [action, type, args] of cases) {
    const name = "room_" + action, { requestId, ...data } = args, sent = [];
    const command = buildWorkCommand(name, args);
    assert.deepEqual(command, { id: requestId, type, data });
    const response = await submitWorkAction({ command: async value => { sent.push(value); return receipt(value); } }, identity, name, args);
    assert.deepEqual(sent, [command]); assert.equal(response.status, "recorded");
    assert.equal(response.appliedRevision, action === "propose_work" ? 0 : args.expectedRevision + 1);
    assert.equal(response.currentStateVerified, false); assert.equal(response.next.tool, "room_read_work");
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
});
