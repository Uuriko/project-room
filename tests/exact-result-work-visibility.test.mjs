import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture } from "./helpers/private-work-fixture.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { operatorNormalization } from "../server/operator-normalization.mjs";
import { textVersion } from "../server/text-results.mjs";

for (const representation of ["legacy", "normalized-current-v1", "adopted"]) {
  test(`a private result question keeps room-visible work readable (${representation})`, async t => {
    const f = await privateWorkFixture(t, representation === "adopted" ? "legacy" : representation);
    const workItemId = "shared-result", evidenceId = "shared-result-text", requestId = "exact-private-question";
    const body = "Shared proposal with a named owner";
    f.send(f.owner, "work.proposed", { workItemId, title: "Shared brief", definitionOfDone: "Name the owner",
      accountableMemberId: f.producer.id, mode: "read" });
    f.send(f.producer.key, "work.accepted", { workItemId, expectedRevision: f.rev(workItemId) });
    f.send(f.producer.key, "work.started", { workItemId, expectedRevision: f.rev(workItemId) });
    const text = f.send(f.producer.key, "message.posted", { messageId: evidenceId, workItemId, body });
    const result = f.send(f.producer.key, "work.completed", { workItemId, expectedRevision: f.rev(workItemId),
      evidenceKind: "room_text", evidenceMessageId: evidenceId, evidenceMessageEventId: text.event.id,
      evidenceVersion: textVersion(body), previousCompletionEventId: null,
      producerId: f.producer.id, summary: "Ready to read", nextAction: "Review the brief" });
    const completionEventId = result.event.id;
    const resultPath = `/work-result?workItemId=${workItemId}&completionEventId=${completionEventId}`;
    const questionPath = "/reply-context?requestMessageId=" + requestId;
    const readResultAsObserver = async () => {
      const observed = await f.rest(f.observer, resultPath);
      assert.equal(observed.status, 200, observed.text);
      assert.equal(observed.json.result.text.body, body);
    };
    await readResultAsObserver();
    const privateBody = "Please confirm the deadline from your notes.";
    f.send(f.owner, "message.posted", { messageId: requestId, workItemId, toMemberId: f.producer.id,
      requestKind: "reply", resultCompletionEventId: completionEventId, replyToId: evidenceId, body: privateBody });

    if (representation === "adopted") {
      const selection = { roomId: "commons", discardLegacyAssignments: true };
      const plan = operatorNormalization(f.store, selection);
      operatorNormalization(f.store, { ...selection, planHash: plan.planHash,
        requestId: "adopt-exact-result-visibility", reason: "Isolated work visibility fixture" }, true);
    }
    await readResultAsObserver();
    const visible = await f.rest(f.producer, questionPath);
    assert.equal(visible.status, 200, visible.text);
    assert.equal(visible.json.request.workItemId, workItemId);
    assert.ok(visible.json.page.items.some(entry => entry.message?.body === privateBody));
    assert.equal(Object.hasOwn(visible.json.request, "resultCompletionEventId"), false);
    const workAsProducer = await f.rest(f.producer, "/work-context?workItemId=shared-result");
    assert.equal(workAsProducer.status, 200, workAsProducer.text);
    assert.ok(workAsProducer.json.replyRequestContext.requests.some(entry => entry.id === requestId));
    const denied = await f.rest(f.observer, questionPath);
    assert.equal(denied.status, 404);
    const discussion = await f.rest(f.observer,
      `/work-discussion?workItemId=${workItemId}&completionEventId=${completionEventId}`);
    assert.equal(discussion.status, 200, discussion.text);
    assert.deepEqual(discussion.json.discussion.replies, []);
    assert.equal((await f.rest(f.observer, "/work-context?workItemId=secret")).status, 403);

    f.send(f.producer.key, "message.posted", { messageId: "exact-question-answer", replyToId: requestId,
      toMemberId: "owner", workItemId, responseToRequestId: requestId, responseOutcome: "answered",
      ...visible.json.current.answerBasis, body: "Friday." });
    await readResultAsObserver();
    assert.equal((await f.rest(f.observer, questionPath)).status, 404);
    f.send(f.owner, "message.posted", { messageId: "continued-exact-question", workItemId,
      toMemberId: f.producer.id, replyToId: "exact-question-answer", requestKind: "reply",
      body: "Thanks. Is that before the review?" });
    await readResultAsObserver();

    // Another member's private questions must not exhaust this work reader's
    // own bounded request window or expose those questions as pointers.
    for (let index = 0; index < 8; index++) {
      f.send(f.owner, "message.posted", { messageId: `additional-exact-question-${index}`, workItemId,
        toMemberId: f.producer.id, requestKind: "reply", resultCompletionEventId: completionEventId,
        replyToId: evidenceId, body: "A private request on the same result." });
    }
    const workAsObserver = await f.rest(f.observer, "/work-context?workItemId=shared-result");
    assert.equal(workAsObserver.status, 200, workAsObserver.text);
    assert.deepEqual(workAsObserver.json.replyRequestContext.requests, []);
    const protectedResult = f.store.workResult(f.owner, "commons", "secret").result;
    const followUp = { messageId: "protected-result-followup", workItemId: "secret",
      requestKind: "reply", resultCompletionEventId: protectedResult.receipt.eventId,
      replyToId: protectedResult.text.messageId, body: "Confirm the owner on this revision." };
    const previousParties = f.store.privateWorkParties("commons", { workIds: ["secret"] }).get("secret");
    assert.throws(() => f.send(f.owner, "message.posted", { ...followUp, toMemberId: f.observer.id }),
      error => error.code === "result_source_unavailable");
    f.send(f.owner, "message.posted", { ...followUp, toMemberId: f.reviewer.id });
    assert.deepEqual(f.store.privateWorkParties("commons", { workIds: ["secret"] }).get("secret"), previousParties);
    assert.equal((await f.rest(f.observer, "/work-result?workItemId=secret")).status, 403);
    assert.doesNotThrow(() => auditRecovery(f.store));
  });
}
