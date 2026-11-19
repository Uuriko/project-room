import test from "node:test";
import assert from "node:assert/strict";
import { attachReleaseReceipts, confirmedReceipt } from "../scripts/attach-release-receipts.mjs";

test("publishes candidate-bound stage receipts and recovers a lost write by replay", async () => {
  const candidateRevision = "a".repeat(40), evidenceVersion = "sha256:" + "b".repeat(64);
  const binding = { workItemId: "work-1", completionEventId: "completion-1", candidateRevision };
  const messages = new Map();
  let loseReport = true, postCalls = 0;
  const raw = x => Buffer.from(JSON.stringify(x));
  const build = raw({ sourceCommit: candidateRevision, sourceTree: "e".repeat(40), verified: true, files: 10, manifestSha256: "c".repeat(64) });
  const browser = raw({ sourceRevision: candidateRevision, clean: true, tests: 2, passed: 2, failed: 0, skipped: 0, exitCode: 0,
    elapsedMs: 30, suites: ["scripts/result-diff-browser-check.mjs"], tapDigest: "sha256:" + "d".repeat(64) });
  const deploy = raw({ oldRevision: "1".repeat(40), newRevision: candidateRevision, phase: "complete", ready: true,
    databasePreserved: true, pinPreserved: true, signedCardVerifiedBeforeShutdown: true,
    liveVersion: { sourceRevision: candidateRevision }, before: { rooms: 1, events: 100 }, after: { rooms: 1, events: 100 },
    recoveryDirectory: "/private/operator/path" });
  const options = {
    binding, inputs: { build, browser, deploy },
    readResult: () => ({ workItemId: binding.workItemId, result: {
      receipt: { eventId: binding.completionEventId, evidenceVersion },
      text: { body: `Scope\nCandidate revision: ${candidateRevision}`, messageId: "result-1" }
    } }),
    post: args => {
      postCalls++;
      const found = messages.get(args.id);
      if (found) assert.deepEqual(args, found);
      else messages.set(args.id, args);
      if (args.id.startsWith("release-checks-") && loseReport) {
        loseReport = false;
        throw new Error("lost response");
      }
      return confirmedReceipt({ status: found ? "duplicate" : "posted", messageId: args.id, sequence: 123, duplicate: Boolean(found) }, args.id);
    }
  };
  await assert.rejects(attachReleaseReceipts({ ...options, inputs: { build, browser: raw({ sourceRevision: "f".repeat(40) }) } }), /mismatched browser/);
  assert.equal(messages.size, 0);
  await assert.rejects(attachReleaseReceipts({ ...options, binding: { ...binding, completionEventId: "wrong-completion" } }), /selected completion/);
  assert.equal(messages.size, 0);
  await assert.rejects(attachReleaseReceipts(options), /Unconfirmed Room write release-checks-/);
  const lookup = ({ operationId }) => messages.has(operationId)
    ? { operationId, status: "recorded", eventType: "message.posted", eventId: "event-1", sequence: 123 }
    : { operationId, status: "not_recorded" };
  const result = await attachReleaseReceipts({ ...options, lookup });
  assert.equal(postCalls, 4);
  assert.ok(result.report.recovered && result.evidence.every(stage => stage.recovered));
  await assert.rejects(attachReleaseReceipts({ ...options, inputs: { build },
    readResult: async () => ({ ...options.readResult(),
      workThread: { releaseChecks: { checks: [{ stage: "browser", evidenceMessageId: "previous-browser" }] } } })
  }), /Missing an already attached stage/);
  assert.equal(postCalls, 4);
  messages.delete(result.report.messageId);
  const missing = await attachReleaseReceipts({ ...options, lookup });
  assert.equal(postCalls, 5);
  assert.equal(missing.report.messageId, result.report.messageId);
  assert.equal(missing.report.duplicate, false);
  assert.equal(messages.size, 4);
  assert.equal(result.report.duplicate, true);
  assert.ok(result.evidence.every(stage => stage.duplicate));
  const report = JSON.parse(messages.get(result.report.messageId).body.split("\n")[1]);
  assert.equal(report.evidenceVersion, evidenceVersion);
  assert.deepEqual(Object.values(report.checks).map(check => check.status), ["passed", "passed", "passed"]);
  assert.ok([...messages.values()].every(message => message.replyToId === "result-1" && !message.body.includes("/private/operator/path")));
  const failedInputs = {
    build: raw({ sourceCommit: candidateRevision, verified: false, failurePhase: "verify" }),
    browser: raw({ ...JSON.parse(browser), passed: 1, skipped: 1 }),
    deploy: raw({ ...JSON.parse(deploy), databasePreserved: false })
  };
  const failed = await attachReleaseReceipts({ ...options, inputs: failedInputs,
    readResult: async () => {
      const result = options.readResult();
      result.result.text.body = JSON.stringify({ sourceRevision: candidateRevision });
      return result;
    } });
  const failures = JSON.parse(messages.get(failed.report.messageId).body.split("\n")[1]);
  assert.deepEqual(Object.values(failures.checks).map(check => check.status), ["failed", "failed", "failed"]);
});
