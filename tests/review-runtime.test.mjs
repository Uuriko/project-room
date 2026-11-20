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
    const store = new RoomStore(":memory:");
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
    const { current, result } = read();
    const input = { workItemId, completionEventId:baseline.id, evidenceVersion:result.receipt.evidenceVersion,
      expectedRevision:current.workRevision, attemptId:"review-baseline", phase:"claimed" };
    const report = (change = {}, token = reviewer.secret) => store.reportReviewRuntime(token, "commons", { ...input, ...change });
    assert.throws(() => report({}, owner), { code:"review_runtime_denied" });
    assert.throws(() => report({evidenceVersion:"changed"}), { code:"review_runtime_stale" });
    const claim = report();
    assert.deepEqual(report(), claim);
    assert.equal(read().reviewRuntime.status, "claimed");
    assert.throws(() => report({attemptId:"another"}), { code:"review_runtime_attempt_conflict" });
    report({phase:"start_unknown"});
    assert.equal(report().status, "start_unknown");
    report({phase:"started"});
    assert.equal(report({phase:"start_unknown"}).status, "started");
    assert.equal(read().current.next.action, "verify");
    act(reviewerKey, T.VERIFICATION_RECORDED, {completionEventId:baseline.id, evidenceVersion:input.evidenceVersion,
      result:"fail", summary:"Needs a corrected result."});
    assert.equal(read().reviewRuntime.status, "verdict_recorded");
    assert.throws(() => report(), { code:"review_runtime_stale" });
    act(owner, T.WORK_BLOCKER_RESOLVED, {resolution:"Attach a correction."}); act(owner, T.WORK_STARTED);
    const corrected = submit("Corrected evidence.", baseline.id);
    assert.equal(read().current.completionEventId, corrected.id);
    assert.equal(read().reviewRuntime.status, "waiting_receiver");
    assert.equal(store.workResult(owner, "commons", workItemId, {completionEventId:baseline.id}).reviewRuntime, undefined);
    assert.throws(() => report(), { code:"review_runtime_stale" });
  });
}
