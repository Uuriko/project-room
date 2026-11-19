import test from "node:test";
import assert from "node:assert/strict";
import { watchCorrectedReview } from "../scripts/watch-corrected-review.mjs";

const scope = { roomId: "commons", memberId: "muse", workItemId: "archive", priorCompletionEventId: "before", after: 10 };
const access = { roomId: scope.roomId, memberId: scope.memberId, permissions: ["verify"] };
const verdict = { tool: "room_record_verification",
  arguments: { workItemId: scope.workItemId, completionEventId: "corrected", expectedRevision: 8, evidenceVersion: "sha256:binding" } };
const selected = {
  current: { completionEventId: "corrected", next: { action: "verify", memberId: scope.memberId } },
  workThread: { correction: { completionEventId: "before" } },
  review: { action: verdict }
};
const signal = { changed: true, sequence: 13, reviewHint: { eventId: "corrected", recordedAt: "2026-11-19T21:00:00.000Z" } };

test("waits for the bound correction, reads only the selected work and binds a stable verdict", async () => {
  const cursors = [];
  const changes = [{ changed: false, through: 11 }, { changed: true, sequence: 12 }, signal];
  const reads = [{ ...selected, workThread: { correction: { completionEventId: "unrelated" } } }, selected];
  const client = {
    checkConnection: async () => access,
    waitForChange: async (after, { reviewWorkItemId }) => {
      assert.equal(reviewWorkItemId, scope.workItemId);
      cursors.push(after);
      return changes.shift();
    },
    workResult: async workId => {
      assert.equal(workId, scope.workItemId);
      return reads.shift();
    }
  };
  const result = await watchCorrectedReview(client, scope);
  assert.deepEqual(cursors, [10, 11, 12]);
  assert.equal(result.status, "review_ready");
  assert.equal(result.wake.matchedCompletionEvent, true);
  assert.equal(result.nextRead.arguments.completionEventId, "corrected");
  assert.deepEqual(result.verdict.arguments, { ...verdict.arguments, requestId: "auto-review-corrected" });
});

test("replaying the cursor after verdict does not offer work again", async () => {
  const client = { checkConnection: async () => access, waitForChange: async () => signal,
    workResult: async () => ({ current: { completionEventId: "corrected", next: { action: "decide" } } }) };
  assert.deepEqual(await watchCorrectedReview(client, scope), { status: "settled", completionEventId: "corrected" });
});
