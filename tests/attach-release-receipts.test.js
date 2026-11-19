import test from "node:test";
import assert from "node:assert/strict";
import { attachReleaseReceipts, confirmedReceipt } from "../scripts/attach-release-receipts.mjs";

test("publishes candidate-bound stage receipts and recovers a lost write by replay", async () => {
  const candidateRevision = "a".repeat(40), evidenceVersion = "sha256:" + "b".repeat(64);
  const binding = { workItemId: "work-1", completionEventId: "completion-1", candidateRevision };
  const messages = new Map();
  let loseReport = true;
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
  await assert.rejects(attachReleaseReceipts(options), /lost response/);
  const result = await attachReleaseReceipts(options);
  assert.equal(messages.size, 4);
  assert.equal(result.report.duplicate, true);
  assert.ok(result.evidence.every(stage => stage.duplicate));
  const report = JSON.parse(messages.get(result.report.messageId).body.split("\n")[1]);
  assert.equal(report.evidenceVersion, evidenceVersion);
  assert.deepEqual(Object.values(report.checks).map(check => check.status), ["passed", "passed", "passed"]);
  assert.ok([...messages.values()].every(message => message.replyToId === "result-1" && !message.body.includes("/private/operator/path")));
});
