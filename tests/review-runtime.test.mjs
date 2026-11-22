import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { textVersion } from "../server/text-results.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

for (const representation of [undefined, "normalized-current-v1"]) {
  test("runtime evidence stays on its exact review and cannot admit execution " + (representation ?? "legacy"), t => {
    let now = Date.parse("2026-11-21T17:00:00Z");
    const store = new RoomStore(":memory:", { now: () => now });
    t.after(() => store.close());
    store.initialize(initialRoom(), { representation });
    const owner = store.issueAccessKey("commons", "owner");
    const reviewer = store.identities.create("Runtime reviewer");
    linkWithProof(store, owner, "commons", reviewer, { displayName: "Runtime reviewer", permissions: ["verify"] });
    const reviewerKey = store.issueAccessKey("commons", reviewer.identityId);
    const workItemId = "exact-runtime";
    const read = () => store.workResult(owner, "commons", workItemId);
    const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data }).event;
    const act = (token, type, data = {}) => send(token, type, { workItemId, expectedRevision: read().current.workRevision, ...data });
    const submit = (body, previousCompletionEventId = null) => {
      const msg = send(owner, T.MESSAGE_POSTED, { workItemId, messageId: randomUUID(), body });
      return act(owner, T.WORK_COMPLETED, { evidenceKind:"room_text", evidenceMessageId:msg.data.messageId,
        evidenceMessageEventId:msg.id, evidenceVersion:textVersion(body), previousCompletionEventId,
        producerId:"owner", summary:body, nextAction:"Review the selected evidence." });
    };
    send(owner, T.WORK_PROPOSED, { workItemId, title:"Exact runtime", definitionOfDone:"Verify the result.",
      accountableMemberId:"owner", mode:"read", independentVerificationRequired:true,
      ownerDecisionRequired:false, verifierMemberId:reviewer.identityId });
    act(owner, T.WORK_ACCEPTED); act(owner, T.WORK_STARTED);
    store.agentHeartbeats.ensureListenerSchema();
    store.workWakes.setHost(reviewer.identityId, "review-fixture", true, "commons");
    const baseline = submit("Initial evidence.");
    assert.equal(read().reviewRuntime.status, "waiting_receiver");
    const [wake] = store.agentHeartbeats.pendingWakePage(reviewer.identityId, {roomId:"commons", hostId:"review-fixture"}).signals;
    assert.equal(wake.completionEventId, baseline.id);
    assert.deepEqual(store.workWakes.ack(reviewer.identityId, [wake.signalId], "commons"), [wake.signalId]);
    const observation = read().reviewRuntime;
    assert.equal(observation.status, "wake_acknowledged");
    assert.equal(observation.source, "managed_pull_wake");
    assert.ok(Number.isFinite(observation.observedAt));
    assert.equal(read().current.next.action, "verify");
    const { current, result } = read();
    const input = { workItemId, completionEventId:baseline.id, evidenceVersion:result.receipt.evidenceVersion,
      expectedRevision:current.workRevision, attemptId:"review-baseline", phase:"claimed" };
    const report = (change = {}, token = reviewer.secret) => store.reportReviewRuntime(token, "commons", { ...input, ...change });
    assert.throws(() => report({}, owner), { code:"review_runtime_denied" });
    assert.throws(() => report({evidenceVersion:"changed"}), { code:"review_runtime_stale" });
    assert.throws(() => report({phase:"start_unknown",reserveDispatch:true}), { code:"review_dispatch_requires_listener" });
    const claim = report();
    now += 10;
    assert.deepEqual(report(), claim);
    assert.equal(read().reviewRuntime.status, "claimed");
    assert.equal(read().reviewRuntime.claimObservedAt, claim.observedAt);
    assert.throws(() => report({attemptId:"another"}), { code:"review_runtime_attempt_conflict" });
    let lease = store.agentHeartbeats.acquireListenerLease({agentId:reviewer.identityId, roomId:"commons", listenerId:"review-fixture"});
    const reserve = (token, reservationId) => store.reportReviewRuntime(reviewer.secret, "commons", {
      ...input, phase:"start_unknown", reserveDispatch:true, ...(reservationId ? {reservationId} : {}),
    }, null, token);
    assert.throws(() => reserve("wrong-token"), { code:"stale_listener" });
    const reservation = reserve(lease.fencingToken, "original-reservation");
    assert.equal(reservation.dispatchGranted, true);
    assert.deepEqual(reserve(lease.fencingToken, "original-reservation"), reservation);
    assert.deepEqual(reserve(lease.fencingToken, "replacement-reservation"), { status:"start_unknown", observedAt:reservation.observedAt });
    assert.deepEqual(reserve(lease.fencingToken), { status:"start_unknown", observedAt:reservation.observedAt });
    assert.equal(report().status, "start_unknown");
    const originalFence = lease.fencingToken;
    store.agentHeartbeats.releaseListenerLease({agentId:reviewer.identityId, roomId:"commons", fencingToken:originalFence});
    lease = store.agentHeartbeats.acquireListenerLease({agentId:reviewer.identityId, roomId:"commons", listenerId:"replacement-fixture"});
    assert.throws(() => reserve(originalFence, "original-reservation"), { code:"stale_listener" });
    assert.deepEqual(reserve(lease.fencingToken, "original-reservation"), { status:"start_unknown", observedAt:reservation.observedAt });
    now += 10;
    report({phase:"started"});
    assert.deepEqual(reserve(lease.fencingToken, "original-reservation"), { status:"started", observedAt:now });
    assert.equal(report({phase:"start_unknown"}).status, "started");
    assert.equal(read().reviewRuntime.claimObservedAt, claim.observedAt);
    assert.equal(read().reviewRuntime.observedAt, now);
    assert.equal(read().current.next.action, "verify");
    act(reviewerKey, T.VERIFICATION_RECORDED, {completionEventId:baseline.id, evidenceVersion:input.evidenceVersion,
      result:"fail", summary:"Needs a corrected result."});
    assert.equal(read().reviewRuntime.status, "verdict_recorded");
    assert.equal(read().reviewRuntime.claimObservedAt, claim.observedAt);
    assert.throws(() => report(), { code:"review_runtime_stale" });
    store.agentHeartbeats.releaseListenerLease({agentId:reviewer.identityId, roomId:"commons", fencingToken:lease.fencingToken});
    act(owner, T.WORK_BLOCKER_RESOLVED, {resolution:"Attach a correction."}); act(owner, T.WORK_STARTED);
    const corrected = submit("Corrected evidence.", baseline.id);
    assert.equal(read().current.completionEventId, corrected.id);
    assert.equal(read().reviewRuntime.status, "waiting_receiver");
    assert.equal(store.workResult(owner, "commons", workItemId, {completionEventId:baseline.id}).reviewRuntime, undefined);
    assert.throws(() => report(), { code:"review_runtime_stale" });
    assert.equal(read().reviewRuntime.claimObservedAt, undefined);
    const correctedReport = phase => store.reportReviewRuntime(reviewer.secret, "commons", {
      ...input, completionEventId:corrected.id, evidenceVersion:textVersion("Corrected evidence."),
      expectedRevision:read().current.workRevision, attemptId:"review-corrected", phase,
    });
    now += 10;
    const started = correctedReport("started");
    assert.equal(read().reviewRuntime.claimObservedAt, undefined);
    now += 10;
    correctedReport("claimed");
    assert.equal(read().reviewRuntime.status, "started");
    assert.equal(read().reviewRuntime.observedAt, started.observedAt);
    assert.equal(read().reviewRuntime.claimObservedAt, now);
    const correctedClaimAt = now;
    const [correctedWake] = store.agentHeartbeats.pendingWakePage(reviewer.identityId, {roomId:"commons", hostId:"review-fixture"}).signals;
    assert.equal(correctedWake.completionEventId, corrected.id);
    now += 10;
    act(reviewerKey, T.VERIFICATION_RECORDED, {completionEventId:corrected.id, evidenceVersion:textVersion("Corrected evidence."),
      result:"pass", summary:"The corrected result meets the criteria."});
    assert.equal(read().reviewRuntime.status, "verdict_recorded");
    assert.equal(read().reviewRuntime.claimObservedAt, correctedClaimAt);
    assert.deepEqual(store.workWakes.ack(reviewer.identityId, [correctedWake.signalId], "commons"), []);
    const wakeAfter = store.db.prepare("SELECT delivered_at,invalidated_at FROM agent_work_wakes WHERE signal_id=?").get(correctedWake.signalId);
    assert.equal(wakeAfter.delivered_at, null);
    assert.equal(wakeAfter.invalidated_at, now);
    const receipts = store.db.prepare(`SELECT completion_id,attempt_id,observed_at
      FROM review_runtime_claim_receipts WHERE room_id='commons' AND work_item_id=? ORDER BY observed_at`).all(workItemId);
    assert.deepEqual(receipts.map(row=>[row.completion_id,row.attempt_id,row.observed_at]),
      [[baseline.id,"review-baseline",claim.observedAt],[corrected.id,"review-corrected",correctedClaimAt]]);
  });
}
