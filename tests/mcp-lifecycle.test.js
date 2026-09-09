import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startWorkLifecycleFixture } from "../scripts/work-lifecycle-agent-fixture.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";

async function fixture(t) {
  const f = await startWorkLifecycleFixture(), handles = new Set();
  t.after(async () => { for (const handle of handles) await handle.close(); await f.close(); });
  const open = async path => { const handle = await openMcpTestClient(path); handles.add(handle); return handle; };
  const close = async handle => { handles.delete(handle); return handle.close(); };
  const ownerToken = JSON.parse(readFileSync(f.ownerFile, "utf8")).token;
  const send = (type, data) => f.store.command(ownerToken, "commons", { id: randomUUID(), type, data });
  const enroll = async (memberId, access) => {
    const session = f.store.createSession(ownerToken), token = randomBytes(32).toString("base64url"), configDirectory = join(f.directory, memberId);
    f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: randomUUID(), memberId,
      displayName: memberId, access, keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
    const config = { version: 1, origin: f.origin, roomId: "commons", memberId, token };
    saveAgentConnection(configDirectory, config); return { mcp: await open(configDirectory), client: new RoomAgentClient(config), configDirectory };
  };
  return { ...f, open, close, send, enroll };
}
const read = async (mcp, workItemId) => (await mcp.call("room_read_work", { workItemId })).result.structuredContent;
async function recorded(mcp, name, args) {
  const result = (await mcp.call(name, args)).result; assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.status, "recorded"); return result.structuredContent;
}
const digest = body => "sha256:" + createHash("sha256").update(body).digest("hex");

test("MCP agents submit native text, read exact history, retry after restart and review without owner approval", { timeout: 30000 }, async t => {
  const f = await fixture(t), writer = await f.enroll("native-writer", "contribute"), reviewer = await f.enroll("native-reviewer", "review"), workItemId = "native-work";
  f.send(T.WORK_PROPOSED, { workItemId, title: "Native text", definitionOfDone: "A short answer inside Room", accountableMemberId: "native-writer",
    verifierMemberId: "native-reviewer", mode: "read", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  const action = async (actor, name, data = {}) => recorded(actor.mcp, name, { requestId: randomUUID(), workItemId,
    expectedRevision: (await read(actor.mcp, workItemId)).work.revision, ...data });
  const result = async (actor, selection = {}) => {
    const response = (await actor.mcp.call("room_read_result", { workItemId, ...selection })).result;
    assert.equal(response.isError, undefined, JSON.stringify(response)); return response.structuredContent;
  };
  const draft = async body => {
    const current = await read(writer.mcp, workItemId);
    const posted = (await writer.mcp.call("room_post_draft", { requestId: randomUUID(), workItemId, packetId: "native-packet", basisRevision: current.work.revision, body })).result.structuredContent;
    const discussion = (await writer.mcp.call("room_read_work_discussion", { workItemId })).result.structuredContent;
    const message = discussion.discussion.items.find(row => row.eventId === posted.eventId);
    assert.equal(posted.messageId, message.message.id);
    const preview = await result(writer, { draftMessageId: message.message.id });
    assert.equal(preview.result.text.body, body); assert.equal(preview.result.text.evidenceVersion, digest(body));
    assert.equal(preview.result.text.proposal.attribution, "manual-unverified");
    return { evidenceMessageId: message.message.id, evidenceMessageEventId: posted.eventId, evidenceVersion: digest(body) };
  };
  await action(writer, "room_accept_work"); await action(writer, "room_start_work");
  const a = await draft("  First answer: café 🪷\n"), original = { requestId: "native-first", workItemId, expectedRevision: 2, ...a,
    previousCompletionEventId: null, producerId: "native-writer", summary: "First version", nextAction: "Review exact text" };
  for (const key of ["previousCompletionEventId", "producerId"]) {
    const missing = { ...original }; delete missing[key]; assert.equal((await writer.mcp.call("room_submit_text_result", missing)).error.code, -32602);
  }
  assert.equal((await writer.mcp.call("room_read_result", { workItemId, completionEventId: "x", draftMessageId: "y" })).error.code, -32602);
  const first = await recorded(writer.mcp, "room_submit_text_result", original);
  assert.equal(first.result.read.arguments.completionEventId, first.eventId); assert.equal(first.currentStateVerified, false);
  assert.equal((await result(reviewer)).result.receipt.eventId, first.eventId);
  await action(reviewer, "room_record_verification", { result: "fail", completionEventId: first.eventId, evidenceVersion: a.evidenceVersion, summary: "Add a next step", nextAction: "Revise" });
  await action(writer, "room_resolve_blocker", { resolution: "Added next step" }); await action(writer, "room_start_work");
  const b = await draft("Second answer: café 🪷\nNext: review."), second = await action(writer, "room_submit_text_result", { ...b,
    previousCompletionEventId: first.eventId, producerId: "native-writer", summary: "Second version", nextAction: "Review" });
  await f.close(writer.mcp); writer.mcp = await f.open(writer.configDirectory);
  const retry = await recorded(writer.mcp, "room_submit_text_result", original); assert.equal(retry.eventId, first.eventId); assert.equal(retry.duplicate, true);
  assert.equal((await result(writer)).result.receipt.eventId, second.eventId);
  assert.equal((await result(reviewer, { completionEventId: first.eventId })).result.text.body, "  First answer: café 🪷\n");
  await action(reviewer, "room_record_verification", { result: "pass", completionEventId: first.eventId, evidenceVersion: a.evidenceVersion, summary: "Historical check" });
  assert.equal((await read(reviewer.mcp, workItemId)).work.verification, null);
  const exact = await result(reviewer);
  await action(reviewer, "room_record_verification", { result: "pass", completionEventId: exact.result.receipt.eventId, evidenceVersion: digest(exact.result.text.body), summary: "Checked the exact revised text" });
  const current = await read(writer.mcp, workItemId);
  assert.equal(current.work.decision, null); assert.equal(current.next.action, "decide"); assert.equal(current.next.memberId, "owner");
  assert.equal((await writer.client.snapshot()).cursor, 0); assert.equal((await reviewer.client.snapshot()).cursor, 0); assert.doesNotThrow(() => auditRecovery(f.store));
});

test("managed contributor and reviewer complete rework and exact-version review without inventing human approval", { timeout: 30000 }, async t => {
  const f = await fixture(t), writer = await f.enroll("managed-writer", "contribute"), reviewer = await f.enroll("managed-reviewer", "review");
  const workItemId = "managed-work";
  f.send(T.WORK_PROPOSED, { workItemId, title: "Managed work", definitionOfDone: "An exact short artifact",
    accountableMemberId: "managed-writer", verifierMemberId: "managed-reviewer", mode: "read",
    independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  const action = async (actor, name, data = {}) => recorded(actor.mcp, name, { requestId: randomUUID(), workItemId,
    expectedRevision: (await read(actor.mcp, workItemId)).work.revision, ...data });
  await action(writer, "room_accept_work"); await action(writer, "room_start_work");
  const original = { requestId: "first-completion", workItemId, expectedRevision: 2, summary: "Version one", evidenceUrl: "https://example.invalid/not-fetched",
    evidenceVersion: digest("Version one"), nextAction: "Review exact summary", producerId: "managed-writer", checksClaimed: ["one", "two"] };
  const first = await recorded(writer.mcp, "room_record_completion", original);
  const changed = (await writer.mcp.call("room_record_completion", { ...original, checksClaimed: ["two", "one"] })).result;
  assert.equal(changed.structuredContent.code, "idempotency_conflict");
  await action(reviewer, "room_record_verification", { result: "fail", completionEventId: first.eventId, evidenceVersion: original.evidenceVersion, summary: "Revise the summary", nextAction: "Write version two" });
  assert.equal((await read(writer.mcp, workItemId)).work.state, "blocked");
  await action(writer, "room_resolve_blocker", { resolution: "Prepared replacement" }); await action(writer, "room_start_work");
  const second = await action(writer, "room_record_completion", { summary: "Version two", evidenceUrl: original.evidenceUrl, evidenceVersion: digest("Version two"), nextAction: "Review new version", producerId: "managed-writer" });
  await f.close(writer.mcp); writer.mcp = await f.open(writer.configDirectory);
  const retry = await recorded(writer.mcp, "room_record_completion", original);
  assert.equal(retry.eventId, first.eventId); assert.equal(retry.duplicate, true); assert.equal(retry.appliedRevision, 3);
  assert.equal((await read(writer.mcp, workItemId)).work.receipt.eventId, second.eventId);
  await action(reviewer, "room_record_verification", { result: "pass", completionEventId: first.eventId, evidenceVersion: original.evidenceVersion, summary: "Historical observation only" });
  assert.equal((await read(reviewer.mcp, workItemId)).work.verification, null);
  await action(reviewer, "room_record_verification", { result: "pass", completionEventId: second.eventId, evidenceVersion: digest("Version two"), summary: "Current artifact meets the definition" });
  const current = await read(writer.mcp, workItemId);
  assert.equal(current.work.verification.independenceConfirmed, true); assert.equal(current.work.decision, null);
  assert.equal(current.next.action, "decide"); assert.equal(current.next.memberId, "owner");
  assert.equal((await writer.client.snapshot()).cursor, 0); assert.equal((await reviewer.client.snapshot()).cursor, 0);
  const before = auditRecovery(f.store).dataSha256;
  const ownerDecision = await reviewer.mcp.call("room_record_owner_decision", { workItemId }); assert.equal(ownerDecision.error.code, -32602);
  assert.equal(auditRecovery(f.store).dataSha256, before);
});

test("chat-only and wrong-assignee tools cannot widen enrollment; unknown producer stays unconfirmed", { timeout: 30000 }, async t => {
  const f = await fixture(t), chat = await f.enroll("managed-chat", "chat"), writer = await f.enroll("managed-writer", "contribute"), reviewer = await f.enroll("managed-reviewer", "review");
  const workItemId = "scope-test";
  f.send(T.WORK_PROPOSED, { workItemId, title: "Scope test", definitionOfDone: "Result", accountableMemberId: "managed-writer", verifierMemberId: "managed-reviewer",
    independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read" });
  const before = auditRecovery(f.store).dataSha256;
  for (const actor of [chat, reviewer]) {
    const response = (await actor.mcp.call("room_accept_work", { requestId: randomUUID(), workItemId, expectedRevision: 0 })).result;
    assert.equal(response.isError, true); assert.equal(response.structuredContent.code, "command_rejected");
  }
  const proposed = (await chat.mcp.call("room_propose_work", { requestId: "not-steering", workItemId: "new", title: "No grant", definitionOfDone: "Must not exist",
    accountableMemberId: "managed-chat", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false })).result;
  assert.equal(proposed.structuredContent.code, "command_rejected"); assert.equal(auditRecovery(f.store).dataSha256, before);
  await recorded(writer.mcp, "room_accept_work", { requestId: "accept", workItemId, expectedRevision: 0 });
  const done = await recorded(writer.mcp, "room_record_completion", { requestId: "unknown-producer", workItemId, expectedRevision: 1,
    summary: "Reported result", evidenceUrl: "https://example.invalid/not-fetched", evidenceVersion: "v1", nextAction: "Review" });
  await recorded(reviewer.mcp, "room_record_verification", { requestId: "unknown-producer-check", workItemId, expectedRevision: 2,
    completionEventId: done.eventId, evidenceVersion: "v1", result: "pass", summary: "The text was checked; its producer is unknown" });
  const current = await read(reviewer.mcp, workItemId); assert.equal(current.work.verification.independenceConfirmed, false);
  assert.equal(current.next.action, "establish_provenance"); assert.equal(current.work.decision, null);
});

test("separate MCP processes serialize overlapping claims, hand off, and never revive a historical reservation", { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.open(f.participants[0].configDirectory), b = await f.open(f.participants[1].configDirectory), pair = [a, b];
  const work = index => f.participants[index].workItemId;
  await Promise.all(pair.map((mcp, index) => recorded(mcp, "room_accept_work", { requestId: "accept", workItemId: work(index), expectedRevision: 0 })));
  const claims = pair.map((_, index) => ({ requestId: "claim", workItemId: work(index), expectedRevision: 1, ...f.manifest.scope }));
  const before = f.store.room("commons").sequence;
  const raced = await Promise.all(pair.map((mcp, index) => mcp.call("room_acquire_claim", claims[index])));
  const winner = raced.findIndex(result => result.result.structuredContent.status === "recorded"), loser = 1 - winner;
  assert.equal(raced[loser].result.structuredContent.code, "claim_conflict"); assert.equal(f.store.room("commons").sequence, before + 1);
  const first = raced[winner].result.structuredContent;
  await recorded(pair[winner], "room_release_claim", { requestId: "release", workItemId: work(winner), expectedRevision: 2 });
  const newClaim = await recorded(pair[loser], "room_acquire_claim", claims[loser]); assert.equal(newClaim.duplicate, false);
  const duplicate = await recorded(pair[winner], "room_acquire_claim", claims[winner]);
  assert.equal(duplicate.eventId, first.eventId); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.currentStateVerified, false);
  assert.equal((await read(pair[winner], work(winner))).work.claim.status, "released");
  assert.equal((await read(pair[loser], work(loser))).work.claim.status, "active");
  const blocked = (await pair[winner].call("room_start_work", { requestId: "late-start", workItemId: work(winner), expectedRevision: 3 })).result;
  assert.equal(blocked.structuredContent.code, "command_rejected");
  const stoppedAt = f.store.room("commons").sequence;
  assert.equal(f.evidence().cursors.every(row => row.sequence === 0), true);
  assert.equal(f.store.room("commons").sequence, stoppedAt);
});

test("authorized coordinator proposes and supersedes work without transferring a claim or approval", { timeout: 30000 }, async t => {
  const f = await fixture(t), memberId = "coordinator";
  f.send(T.MEMBER_ADDED, { memberId, displayName: "Synthetic coordinator", kind: "agent", accountableHumanId: "owner", permissions: ["steer"] });
  const configDirectory = join(f.directory, memberId);
  saveAgentConnection(configDirectory, { version: 1, origin: f.origin, roomId: "commons", memberId, token: f.store.issueAccessKey("commons", memberId) });
  const coordinator = await f.open(configDirectory), a = await f.open(f.participants[0].configDirectory);
  const proposal = { requestId: "coordinator-propose", workItemId: "replacement", title: "Replacement definition",
    definitionOfDone: "A revised explicit result", accountableMemberId: "agent-a", mode: "write",
    independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: "owner" };
  const proposed = await recorded(coordinator, "room_propose_work", proposal);
  const originalReplacement = (await read(coordinator, "replacement")).work;
  await recorded(a, "room_accept_work", { requestId: "accept-original", workItemId: "work-agent-a", expectedRevision: 0 });
  await recorded(a, "room_acquire_claim", { requestId: "claim-original", workItemId: "work-agent-a", expectedRevision: 1, ...f.manifest.scope });
  const supersession = { requestId: "coordinator-supersede", workItemId: "work-agent-a", expectedRevision: 2,
    supersededByWorkItemId: "replacement", reason: "The agreed definition changed" };
  const replaced = await recorded(coordinator, "room_supersede_work", supersession);
  const original = await read(a, "work-agent-a");
  assert.equal(original.work.state, "superseded"); assert.equal(original.work.claim.status, "superseded");
  assert.equal(original.work.decision, null);
  assert.deepEqual((await read(a, "replacement")).work, originalReplacement);
  for (const [name, args, saved] of [["room_propose_work", proposal, proposed], ["room_supersede_work", supersession, replaced]]) {
    const retry = await recorded(coordinator, name, args);
    assert.equal(retry.eventId, saved.eventId); assert.equal(retry.duplicate, true); assert.equal(retry.currentStateVerified, false);
  }
  assert.deepEqual((await read(a, "replacement")).work, originalReplacement);
});

test("expired claim rejects new work while its original successful acquisition remains retryable without renewal", { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.open(f.participants[0].configDirectory), workItemId = "work-agent-a";
  await recorded(a, "room_accept_work", { requestId: "accept-expiring", workItemId, expectedRevision: 0 });
  const input = { requestId: "expiring-claim", workItemId, expectedRevision: 1, ...f.manifest.scope };
  const original = await recorded(a, "room_acquire_claim", input);
  // Advance only this disposable store clock; no sleeps or global time changes.
  f.store.now = () => Date.parse(input.expiresAt) + 1;
  const before = auditRecovery(f.store).dataSha256;
  const start = (await a.call("room_start_work", { requestId: "expired-start", workItemId, expectedRevision: 2 })).result;
  const completion = (await a.call("room_record_completion", { requestId: "expired-result", workItemId, expectedRevision: 2,
    summary: "Must not be saved", evidenceUrl: "https://example.invalid/not-fetched", evidenceVersion: "v1", nextAction: "Review", producerId: "agent-a" })).result;
  for (const result of [start, completion]) assert.equal(result.structuredContent.code, "command_rejected");
  const retry = await recorded(a, "room_acquire_claim", input);
  assert.equal(retry.eventId, original.eventId); assert.equal(retry.duplicate, true); assert.equal(retry.currentStateVerified, false);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  const current = await read(a, workItemId);
  assert.equal(current.work.claim.expiresAt, input.expiresAt); assert.equal(current.work.receipt, null);
  assert.equal(current.next.action, "claim"); assert.equal(current.work.revision, 2);
});

test("managed contributor can accept but cannot acquire outside-write authority through MCP", { timeout: 30000 }, async t => {
  const f = await fixture(t), contributor = await f.enroll("managed-contributor", "contribute"), workItemId = "managed-write";
  f.send(T.WORK_PROPOSED, { workItemId, title: "Scoped work", definitionOfDone: "Result", accountableMemberId: "managed-contributor",
    mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false });
  await recorded(contributor.mcp, "room_accept_work", { requestId: "accept-managed-write", workItemId, expectedRevision: 0 });
  const before = auditRecovery(f.store).dataSha256;
  const result = (await contributor.mcp.call("room_acquire_claim", { requestId: "no-outside-grant", workItemId, expectedRevision: 1, ...f.manifest.scope })).result;
  assert.equal(result.structuredContent.code, "command_rejected");
  assert.equal(auditRecovery(f.store).dataSha256, before);
  assert.equal((await read(contributor.mcp, workItemId)).work.claim, null);
});
