import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateKeyPair, publicKeyToJwk, signCardJws } from "../server/agent-card-signing.mjs";
import { attachReleaseReceipts, confirmedReceipt, packageFixtureEvidence, prepareReleaseReview, prepareReleaseReviewPacket, publishReleaseProofParts, submitReleaseReview } from "../scripts/attach-release-receipts.mjs";

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
  await assert.rejects(attachReleaseReceipts({ ...options, expectedBody: "prepared signed packet" }), /differs from the prepared signed packet/);
  assert.equal(postCalls, 0);
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

test("release review requires complete exact evidence before its single completion and recovers both lost responses", async () => {
  const candidateRevision = "a".repeat(40), sha = "c".repeat(64);
  const origin = new URL("https://local-room.example");
  const binding = { roomId: "test", workItemId: "release", candidateRevision };
  const input = {
    build: { sourceCommit: candidateRevision, sourceTree: candidateRevision, manifestSha256: sha, files: 10, verified: true },
    browser: { sourceRevision: candidateRevision, clean: true, tests: 1, passed: 1, failed: 0, skipped: 0, elapsedMs: 7,
      exitCode: 0, tapDigest: "sha256:" + sha, suites: ["scripts/result-diff-browser-check.mjs"] },
    deploy: { oldRevision: "b".repeat(40), newRevision: candidateRevision, phase: "complete", ready: true,
      liveVersion: { sourceRevision: candidateRevision }, databasePreserved: true, pinPreserved: true,
      signedCardVerifiedBeforeShutdown: true, before: { rooms: 1, events: 3 }, after: { rooms: 1, events: 3 } }
  };
  const report = storage => Buffer.from(JSON.stringify({
    source: candidateRevision, storage, checks: ["fixture-storage-representation", "exact-stamped-source"],
    passed: true, disposableDataRemoved: true
  }));
  const reports = { legacy: report("legacy"), normalized: report("normalized") };
  assert.throws(() => packageFixtureEvidence({ ...reports, normalized: reports.legacy }, candidateRevision), /normalized package fixture/);
  assert.throws(() => packageFixtureEvidence(reports, "f".repeat(40)), /legacy package fixture/);
  input.build.packageFixtures = packageFixtureEvidence(reports, candidateRevision);
  const inputs = Object.fromEntries(Object.entries(input).map(([stage, value]) => [stage, Buffer.from(JSON.stringify(value))]));
  const prepare = overrides => prepareReleaseReview({ inputs, candidateRevision, origin, verificationPath: "/docs/agents/paste",
    servingRevision: candidateRevision, verificationDigest: "sha256:" + sha, ...overrides });
  assert.throws(() => prepare({ inputs: { build: inputs.build } }), /Missing browser/);
  assert.throws(() => prepare({ servingRevision: input.deploy.oldRevision }), /exact serving candidate/);
  assert.throws(() => prepare({ verificationPath: "https://retired.example/docs/" }), /configured serving origin/);
  const body = prepare();
  assert.match(body, /https:\/\/local-room\.example\/api\/version/);
  assert.match(body, /https:\/\/local-room\.example\/docs\/agents\/paste/);
  assert.match(body, /build: [\s\S]+browser: [\s\S]+deploy: /);
  assert.match(body, /"packageFixtures":\[{"storage":"legacy"/);
  assert.match(body, /"storage":"normalized"/);
  assert.match(body, /response-body digest sha256:/);
  assert.equal((body.match(/"passedCheckCount":2/g) ?? []).length, 2);
  const oldFixtures = input.build.packageFixtures.map(({passedCheckCount, ...fixture}) => fixture);
  const oldBuild = Buffer.from(JSON.stringify({ ...input.build, packageFixtures: oldFixtures }));
  const oldBody = prepare({ inputs: { ...inputs, build: oldBuild } });
  assert.match(oldBody, /HTTP 200, sha256:/);
  assert.doesNotMatch(oldBody, /passedCheckCount|response-body digest/);
  const miscount = Buffer.from(JSON.stringify({ ...input.build, packageFixtures: [
    { ...input.build.packageFixtures[0], passedCheckCount: 21 }, input.build.packageFixtures[1]
  ] }));
  assert.throws(() => prepare({ inputs: { ...inputs, build: miscount } }), /mismatched packaged storage/);
  assert.notEqual(...input.build.packageFixtures.map(report => report.evidenceDigest));
  const mismatched = Buffer.from(JSON.stringify({
    ...input.build, packageFixtures: [input.build.packageFixtures[0], input.build.packageFixtures[0]]
  }));
  assert.throws(() => prepare({ inputs: { ...inputs, build: mismatched } }), /mismatched packaged storage/);
  const { privateKey, publicKey } = generateKeyPair();
  const jku = new URL("/.well-known/jwks.json", origin).href;
  const keyId = "instance-key";
  const jwks = { keys: [publicKeyToJwk({ publicKey, keyId })] };
  const qualification = Object.fromEntries([
    ["build", "build.json"], ["browser", "browser.json"], ["deploy", "deployment-result.json"]
  ].map(([stage, file]) => [file, createHash("sha256").update(inputs[stage]).digest("hex")]));
  const proof = {
    schema: "project-room-batch-source-to-package/1", origin: origin.origin, ...binding,
    composition: { previous: input.deploy.oldRevision, revision: candidateRevision, tree: input.build.sourceTree },
    package: { manifestSha256: sha, files: 10 }, qualification
  };
  const signed = card => ({ proof: card, signature: signCardJws({ card, privateKey, keyId, jku }) });
  const provenance = signed(proof);
  const bound = sourceProof => prepare({ binding, sourceProof, jwks });
  const signedBody = bound(provenance);
  assert.deepEqual(JSON.parse(signedBody.split("\n").at(-1)), provenance);
  assert.doesNotMatch(signedBody, /"packageFixtures"/, "full stage receipts stay linked separately");
  assert.match(signedBody, /response-body digest sha256:/);
  assert.throws(() => bound(signed({ ...proof, workItemId: "other-work" })), /does not match/);
  assert.throws(() => bound(signed({ ...proof, qualification: { ...qualification, "browser.json": sha } })), /does not match/);
  assert.throws(() => bound({ ...provenance, proof: { ...proof, publicTip: input.deploy.oldRevision } }), /signature/);
  const large = signed({ ...proof, package: { ...proof.package, pathSha256: Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`server/proof-😀-${index}.mjs`, { publicSha: sha, composedSha: sha, installedSha: sha }])
  ) } });
  const packet = prepareReleaseReviewPacket({ inputs, candidateRevision, origin, verificationPath: "/docs/agents/paste",
    servingRevision: candidateRevision, verificationDigest: "sha256:" + sha, binding,
    sourceProof: { ...large, unsignedMetadata: "local-only metadata" }, jwks });
  assert.ok(packet.parts.length > 1);
  assert.ok(packet.body.length <= 4000);
  assert.deepEqual(JSON.parse(Buffer.from(packet.parts.map(part => part.body.split("\n")[1]).join(""), "base64url")), large);
  assert.ok(packet.parts.every(part => part.body.length <= 4000 && packet.body.includes(part.id)));
  const savedParts = new Map();
  let writes = 0;
  const publish = () => publishReleaseProofParts({ parts: packet.parts, binding, producerId: "producer", call: async (name, args) => {
    const id = args.operationId ?? args.id ?? args.draftMessageId;
    const prior = savedParts.get(id);
    if (name === "room_receipt") return { roomId: binding.roomId, viewerId: "producer", operationId: id,
      status: prior ? "recorded" : "not_recorded", ...(prior ? { eventType: "message.posted", sequence: prior.sequence } : {}) };
    if (name === "room_post_message") {
      assert.equal(args.workItemId, binding.workItemId);
      assert.equal(prior, undefined, "The first write is recovered from its receipt");
      savedParts.set(id, { body: args.body, sequence: ++writes });
      if (writes === 1) throw new Error("proof response lost");
      return { messageId: id, sequence: writes, status: "posted", duplicate: false };
    }
    assert.equal(name, "room_read_result");
    return { roomId: binding.roomId, workItemId: binding.workItemId, result: { text: { messageId: id, body: prior.body } } };
  } });
  await assert.rejects(publish(), /proof response lost/);
  assert.equal((await publish()).length, packet.parts.length);
  assert.equal(writes, packet.parts.length);
  savedParts.get(packet.parts[0].id).body += "changed";
  await assert.rejects(publish(), /attachment does not match/);

  const operations = new Map();
  const next = { action: "in_progress", memberId: "producer" };
  let currentRevision = 4, posts = 0, submissions = 0, draftArgs;
  const call = (name, args) => {
    if (name === "room_receipt") return { ...args, roomId: "test", viewerId: "producer", status: "not_recorded", ...operations.get(args.operationId) };
    if (name === "room_read_work") return { revision: currentRevision, continuation: next };
    if (name === "room_post_message") {
      posts++;
      draftArgs = args;
      operations.set(args.id, { status: "recorded", eventId: "draft-event", eventType: "message.posted" });
      throw new Error("draft response lost");
    }
    if (name === "room_read_result") return { current: { next, workRevision: currentRevision, completionEventId: null },
      result: { text: { body: draftArgs.body, messageId: draftArgs.id, messageEventId: "draft-event", evidenceVersion: "sha256:" + sha } } };
    assert.equal(name, "room_submit_text_result");
    submissions++;
    assert.equal(args.evidenceMessageId, draftArgs.id);
    operations.set(args.requestId, { status: "recorded", eventId: "completion-event", eventType: "work.completed" });
    throw new Error("completion response lost");
  };
  const request = { binding, expectedRevision: 3, producerId: "producer", body: signedBody, call };
  await assert.rejects(submitReleaseReview(request), /not in progress at the selected revision/);
  assert.equal(posts, 0);
  currentRevision = 3;
  await assert.rejects(submitReleaseReview(request), /draft response lost/);
  await assert.rejects(submitReleaseReview(request), /completion response lost/);
  assert.equal((await submitReleaseReview(request)).completionEventId, "completion-event");
  assert.equal(posts, 1);
  assert.equal(submissions, 1);
});
