import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verifyCardJws } from "../server/agent-card-signing.mjs";

import { releaseSmokePlan, releaseSmokeWorkId } from "../server/release-smoke.mjs";

const revision = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash("sha256").update(value).digest("hex");
const stages = ["build", "browser", "deploy"];

const fixtureModes = ["legacy", "normalized"];
const fixtureChecks = checks => Array.isArray(checks) && checks.length > 0 && checks.length <= 32
  && checks.every(check => typeof check === "string" && /^[a-z0-9-]{1,70}$/.test(check));

export function packageFixtureEvidence(reports, candidateRevision) {
  return fixtureModes.map(storage => {
    const raw = reports[storage], report = raw && JSON.parse(raw.toString("utf8"));
    if (!revision.test(candidateRevision) || report?.source !== candidateRevision || report.storage !== storage
        || report.passed !== true || report.disposableDataRemoved !== true || !fixtureChecks(report.checks)) {
      throw new Error(`Invalid or mismatched ${storage} package fixture report.`);
    }
    return { storage, source: report.source, checks: report.checks, evidenceDigest: "sha256:" + hash(raw),
      passedCheckCount: report.checks.length };
  });
}

function stageEvidence(stage, value, candidate) {
  if (stage === "build" && value?.sourceCommit === candidate && value.verified === true
      && revision.test(value.sourceTree) && /^[a-f0-9]{64}$/.test(value.manifestSha256)
      && integer(value.files) && value.files > 0) {
    const { sourceCommit, sourceTree, manifestSha256, files, verified, packageFixtures } = value;
    if (packageFixtures !== undefined && (!Array.isArray(packageFixtures) || packageFixtures.length !== fixtureModes.length
        || !fixtureModes.every((mode, at) => {
          const report = packageFixtures[at];
          return report?.storage === mode && report.source === candidate && digest.test(report.evidenceDigest)
            && fixtureChecks(report.checks)
            && (report.passedCheckCount === undefined || report.passedCheckCount === report.checks.length);
        }))) throw new Error("Invalid or mismatched packaged storage fixture evidence.");

    return { status: "passed", summary: `Runtime package verified, ${files} files.`,
      proof: { sourceCommit, sourceTree, manifestSha256, files, verified,
        ...(packageFixtures ? { packageFixtures: packageFixtures.map(({storage, source, checks, evidenceDigest, passedCheckCount}) =>
          ({storage, source, checks, evidenceDigest, ...(passedCheckCount === undefined ? {} : {passedCheckCount})})) } : {}) } };
  }
  if (stage === "build" && value?.sourceCommit === candidate && value.verified === false
      && ["package", "verify", "instance-card", "staged-legacy", "staged-normalized"].includes(value.failurePhase)) {
    const { sourceCommit, verified, failurePhase } = value;
    return { status: "failed", summary: `Build stopped during ${failurePhase}.`, proof: { sourceCommit, verified, failurePhase } };
  }
  if (stage === "browser" && value?.sourceRevision === candidate && value.clean === true
      && [value.tests, value.passed, value.failed, value.skipped, value.elapsedMs].every(integer)
      && value.tests > 0 && value.tests === value.passed + value.failed + value.skipped
      && integer(value.exitCode) && digest.test(value.tapDigest) && Array.isArray(value.suites)
      && value.suites.length > 0 && value.suites.length <= 30
      && value.suites.every(suite => /^scripts\/[a-z0-9-]+-browser-check\.mjs$/.test(suite))) {
    const { sourceRevision, clean, tests, passed, failed, skipped, elapsedMs, exitCode, tapDigest, suites } = value;
    return { status: exitCode === 0 && passed === tests ? "passed" : "failed",
      summary: `${passed}/${tests} browser checks passed, ${failed} failed, ${skipped} skipped.`,
      proof: { sourceRevision, clean, tests, passed, failed, skipped, elapsedMs, exitCode, tapDigest, suites } };
  }
  if (stage === "deploy" && value?.newRevision === candidate && revision.test(value.oldRevision)) {
    const { newRevision, oldRevision, phase, ready, databasePreserved, pinPreserved, signedCardVerifiedBeforeShutdown } = value;
    const sourceRevision = value.liveVersion?.sourceRevision;
    if (phase === "complete" && ready === true && sourceRevision === candidate
        && databasePreserved === true && pinPreserved === true && signedCardVerifiedBeforeShutdown === true
        && integer(value.before?.rooms) && integer(value.before?.events)
        && value.after?.rooms === value.before.rooms && integer(value.after?.events) && value.after.events >= value.before.events) {
      return { status: "passed", summary: "Candidate observed ready at its exact live revision. Database history and instance pin preserved.",
        proof: { newRevision, oldRevision, phase, ready, sourceRevision, databasePreserved, pinPreserved,
          signedCardVerifiedBeforeShutdown, rooms: value.after.rooms, eventsBefore: value.before.events, eventsAfter: value.after.events } };
    }
    if (phase === "complete" && [ready, databasePreserved, pinPreserved, signedCardVerifiedBeforeShutdown].every(flag => typeof flag === "boolean")
        && revision.test(sourceRevision) && integer(value.before?.rooms) && integer(value.before?.events)
        && integer(value.after?.rooms) && integer(value.after?.events)) {
      return { status: "failed", summary: "Post-deploy verification did not confirm all release invariants.",
        proof: { newRevision, oldRevision, phase, ready, sourceRevision, databasePreserved, pinPreserved,
          signedCardVerifiedBeforeShutdown, roomsBefore: value.before.rooms, roomsAfter: value.after.rooms,
          eventsBefore: value.before.events, eventsAfter: value.after.events } };
    }
    if (["preflight", "backup", "switch", "verify"].includes(phase) && typeof value.failure === "string") {
      return { status: "failed", summary: `Deployment stopped during ${phase}.`,
        proof: { newRevision, oldRevision, phase, priorApplicationRecovered: value.priorApplicationRecovered === true } };
    }
  }
  throw new Error(`Invalid or mismatched ${stage} receipt for the exact candidate.`);
}

export async function attachReleaseReceipts({ binding, inputs, readResult, lookup, post, requirePreparedEvidence = false, expectedBody, handoffSmoke }) {
  const { workItemId, completionEventId, candidateRevision } = binding;
  if (typeof workItemId !== "string" || !workItemId || typeof completionEventId !== "string" || !completionEventId
      || !revision.test(candidateRevision)) throw new Error("Expected a work item, exact completion event and 40-hex candidate.");

  const smokeTest = releaseSmokePlan(binding.smokeTest);
  if (binding.smokeTest !== undefined && (!smokeTest || typeof handoffSmoke !== "function")) {
    throw new Error("Expected a smoke criterion, distinct assignee and verifier, and a handoff connection.");
  }
  const prepared = [];
  for (const stage of stages) {
    if (inputs[stage] === undefined) continue;
    const raw = inputs[stage];
    const { status, summary, proof } = stageEvidence(stage, JSON.parse(raw.toString("utf8")), candidateRevision);
    const evidenceDigest = "sha256:" + hash(raw);
    const body = `room-release-receipt/1 ${stage} ${completionEventId} ${candidateRevision} ${evidenceDigest}\n`
      + "Receipt fields from the operator record. Digest covers the original file.\n\n" + JSON.stringify(proof, null, 2);
    const id = "release-stage-" + hash(JSON.stringify([workItemId, body]));
    prepared.push({ stage, body, id, check: { candidateRevision, status, summary, evidenceDigest, evidenceMessageId: id } });
  }
  if (prepared.length === 0) throw new Error("Supply at least one existing stage receipt.");

  const selected = await readResult({ workItemId, completionEventId });
  const { receipt, text } = selected.result ?? {};
  const candidates = new Set([...((text?.body ?? "").matchAll(/(?:^Candidate revision: |"sourceRevision"\s*:\s*")([a-f0-9]{40})(?:"|\r?$)/gm))].map(match => match[1]));
  if (selected.workItemId !== workItemId || receipt?.eventId !== completionEventId
      || !digest.test(receipt.evidenceVersion) || !text?.messageId || candidates.size !== 1 || !candidates.has(candidateRevision)) {
    throw new Error("The selected completion does not name this exact candidate.");
  }
  if (expectedBody !== undefined && text.body !== expectedBody) {
    throw new Error("The saved release result differs from the prepared signed packet.");
  }
  if (requirePreparedEvidence &&
      prepared.some(({ stage, check }) => !text.body.split("\n").includes(`${stage}: ${check.summary} ${check.evidenceDigest}`))) {
    throw new Error("The stage files no longer match the evidence in the submitted release result.");
  }
  if (smokeTest && selected.scope?.workVisibility !== "room") {
    throw new Error("A release smoke handoff requires a room-visible Work Thread.");
  }
  const previousReport = selected.workThread?.releaseChecks;
  if (previousReport?.smokeTest && JSON.stringify(previousReport.smokeTest) !== JSON.stringify(smokeTest)) {
    throw new Error("The exact release already declares a different smoke test.");
  }
  const deploy = prepared.find(item => item.stage === "deploy")?.check;
  if (smokeTest && deploy?.status === "passed" && selected.selection?.status !== "current") {
    throw new Error("The exact deploy is no longer the current Work Thread result.");
  }
  const previouslyAttached = previousReport?.checks ?? [];
  if (previouslyAttached.some(check => check.evidenceMessageId && !prepared.some(item => item.stage === check.stage))) {
    throw new Error("Missing an already attached stage. Restore its original receipt file before publishing.");
  }
  const send = async (id, body) => {
    if (lookup) {
      const prior = await lookup({ operationId: id });
      if (prior.operationId !== id || (binding.roomId && prior.roomId !== binding.roomId)) {
        throw new Error(`Unexpected Room lookup for operation ${id}.`);
      }
      if (prior.status === "recorded" && prior.eventType === "message.posted" && prior.eventId
          && Number.isSafeInteger(prior.sequence) && prior.sequence > 0) {
        return { messageId: id, sequence: prior.sequence, duplicate: true, recovered: true };
      }
      if (prior.status !== "not_recorded") throw new Error(`Unconfirmed Room lookup for operation ${id}.`);
    }
    try {
      return await post({ id, compact: true, workItemId, replyToId: text.messageId, body });
    } catch (error) {
      throw new Error(`Unconfirmed Room write ${id}. Recover with the saved receipt files.`, { cause: error });
    }
  };
  const evidence = [];
  for (const { stage, id, body } of prepared) {
    evidence.push({ stage, ...await send(id, body) });
  }
  const report = { candidateRevision, completionEventId, evidenceVersion: receipt.evidenceVersion,
    checks: Object.fromEntries(prepared.map(({ stage, check }) => [stage, check])), ...(smokeTest ? { smokeTest } : {}) };
  const reportBody = "room-release-checks/1\n" + JSON.stringify(report);
  const published = await send("release-checks-" + hash(JSON.stringify([workItemId, reportBody])), reportBody);
  let smoke;
  if (smokeTest && deploy?.status === "passed") {
    const id = releaseSmokeWorkId(workItemId, completionEventId, candidateRevision);
    smoke = await handoffSmoke({ candidateRevision, parentWorkItemId: workItemId, completionEventId, sourceMessageId: deploy.evidenceMessageId,
      workItemId: id, requestId: id, ...smokeTest });
  }
  return { candidateRevision, completionEventId, report: published, evidence, ...(smoke ? { smokeTest: smoke } : {}) };
}

export function confirmedReceipt(saved, id) {
  if (saved.messageId !== id || !Number.isSafeInteger(saved.sequence) || saved.sequence <= 0
      || saved.status !== (saved.duplicate === true ? "duplicate" : "posted")) {
    throw new Error("Unexpected receipt. Replay the same files.");
  }
  return { messageId: saved.messageId, sequence: saved.sequence, duplicate: saved.duplicate === true };
}

function checkedSourceProof({ sourceProof, jwks, origin, binding, checks }) {
  const { proof, signature } = sourceProof ?? {};
  const jwksUrl = new URL("/.well-known/jwks.json", origin).href;
  let header;
  try {
    header = JSON.parse(Buffer.from(signature?.protected ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid release source proof signature header.");
  }
  const key = Array.isArray(jwks?.keys) && jwks.keys.find(item => item?.kid === header?.kid
    && item.kty === "OKP" && item.crv === "Ed25519" && typeof item.x === "string");
  if (header?.jku !== jwksUrl || !key
      || !verifyCardJws({ card: proof, jws: signature, publicKey: Buffer.from(key.x, "base64url").toString("base64") })) {
    throw new Error("Invalid release source proof signature.");
  }
  const [build, browser, deploy] = checks;
  if (!binding || proof?.schema !== "project-room-batch-source-to-package/1" || proof.origin !== origin.origin
      || proof.roomId !== binding.roomId || proof.workItemId !== binding.workItemId
      || binding.candidateRevision !== build.proof.sourceCommit || proof.composition?.revision !== binding.candidateRevision
      || proof.composition?.previous !== deploy.proof.oldRevision
      || proof.composition?.tree !== build.proof.sourceTree || proof.package?.manifestSha256 !== build.proof.manifestSha256
      || proof.package?.files !== build.proof.files || proof.qualification?.["build.json"] !== build.evidenceDigest.slice(7)
      || proof.qualification?.["browser.json"] !== browser.evidenceDigest.slice(7)
      || proof.qualification?.["deployment-result.json"] !== deploy.evidenceDigest.slice(7)) {
    throw new Error("Release source proof does not match the exact work, candidate and stage receipts.");
  }
  return `Signed source-to-package proof (same-origin JWKS).\n${JSON.stringify({ proof, signature })}`;
}

export function prepareReleaseReview({ inputs, candidateRevision, origin, verificationPath, servingRevision, verificationDigest,
  binding, sourceProof, jwks }) {
  if (!revision.test(candidateRevision) || servingRevision !== candidateRevision || !digest.test(verificationDigest)) {
    throw new Error("Verify the exact serving candidate before preparing review.");
  }
  const verification = new URL(verificationPath, origin);
  if (verification.origin !== origin.origin || verification.username || verification.password || verification.search || verification.hash) {
    throw new Error("Verification must name a path on the configured serving origin.");
  }
  const checks = stages.map(stage => {
    const raw = inputs[stage];
    if (!raw) throw new Error(`Missing ${stage} evidence before release review.`);
    const { status, summary, proof } = stageEvidence(stage, JSON.parse(raw.toString("utf8")), candidateRevision);
    if (status !== "passed") throw new Error(`Release review requires passing ${stage} evidence.`);
    return { stage, summary, proof, evidenceDigest: "sha256:" + hash(raw) };
  });
  const fixtures = checks[0].proof.packageFixtures;
  const digestLabel = fixtures?.every(fixture => fixture.passedCheckCount !== undefined) ? "response-body digest " : "";
  const signed = sourceProof === undefined ? null : checkedSourceProof({ sourceProof, jwks, origin, binding, checks });
  const body = [
    `Candidate revision: ${candidateRevision}`,
    `Serving revision: ${new URL("/api/version", origin).href}`,
    `Live verification: ${verification.href} (HTTP 200, ${digestLabel}${verificationDigest})`,
    ...(signed ? [
      `Checks: package verified (${checks[0].proof.files} files), browser ${checks[1].proof.passed}/${checks[1].proof.tests} passed, deploy ready.`,
      signed
    ] : checks.map(({ stage, summary, proof, evidenceDigest }) => `${stage}: ${summary} ${evidenceDigest}\n${JSON.stringify(proof)}`))
  ].join("\n\n");
  if (body.length > 4096) throw new Error("The prepared release evidence exceeds the Room text limit.");
  return body;
}

export async function submitReleaseReview({ binding, expectedRevision, producerId, body, call }) {
  const { roomId, workItemId, candidateRevision } = binding;
  if (!roomId || !workItemId || !producerId || !integer(expectedRevision) || !revision.test(candidateRevision)) {
    throw new Error("Expected a Room, work item, assigned producer, exact work revision and candidate.");
  }
  const key = hash(JSON.stringify([roomId, workItemId, expectedRevision, candidateRevision]));
  const draftId = `release-draft-${key}`, requestId = `release-submit-${key}`;
  async function lookup(operationId, eventType) {
    const result = await call("room_receipt", { operationId });
    if (result.operationId !== operationId || result.roomId !== roomId || result.viewerId !== producerId) {
      throw new Error("Receipt did not match this release operation.");
    }
    if (result.status === "not_recorded") return null;
    if (result.status === "recorded" && result.eventType === eventType && typeof result.eventId === "string") return result;
    throw new Error("Could not confirm the release operation receipt.");
  }

  const saved = await lookup(requestId, "work.completed");
  if (saved) return { ...binding, completionEventId: saved.eventId };

  const savedDraft = await lookup(draftId, "message.posted");
  let posted;
  if (!savedDraft) {
    const current = await call("room_read_work", { workItemId, brief: true });
    if (current.revision !== expectedRevision || current.continuation?.action !== "in_progress"
        || current.continuation.memberId !== producerId) {
      throw new Error("Release work is not in progress at the selected revision for this producer.");
    }
    posted = await call("room_post_message", { id: draftId, workItemId, body, maxResultCodeUnits: body.length });
  }
  let submission = posted?.resultDraft?.submission;
  if (!submission) {
    const preview = await call("room_read_result", { workItemId, draftMessageId: draftId });
    const text = preview.result?.text;
    if (preview.current?.next?.action !== "in_progress" || preview.current.next.memberId !== producerId
        || text?.body !== body || text.messageEventId !== (savedDraft ?? posted)?.eventId) {
      throw new Error("The saved release draft no longer matches this review input.");
    }
    submission = { workItemId, expectedRevision: preview.current.workRevision, evidenceMessageId: text.messageId,
      evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion,
      previousCompletionEventId: preview.current.completionEventId };
  }
  if (submission.expectedRevision !== expectedRevision || submission.workItemId !== workItemId) {
    throw new Error("Release work revision changed. Read the current task before starting a new operation.");
  }
  const completion = await call("room_submit_text_result", {
    ...submission, requestId, producerId, summary: "Release evidence collected for independent review",
    nextAction: "Check the exact candidate, stage receipts, and serving URLs."
  });
  if (typeof completion.eventId !== "string" || !completion.eventId) throw new Error("Unconfirmed release completion. Retry the same binding.");
  return { ...binding, completionEventId: completion.eventId };
}

async function main() {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(["binding", "build", "browser", "deploy"].map(name => [name, { type: "string" }])),
    recover: { type: "boolean", default: false },
    "source-proof": { type: "string" },
    "work-revision": { type: "string" }, "verify-path": { type: "string", default: "/api/ready" }
  } });
  const origin = new URL(process.env.ROOM_RELEASE_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.href !== origin.origin + "/") {
    throw new Error("ROOM_RELEASE_ORIGIN must be an HTTPS origin.");
  }
  let binding = JSON.parse(await readFile(values.binding, "utf8"));
  const { identitySecret, roomId, memberId } = JSON.parse(await readFile(process.env.ROOM_RELEASE_CONNECTION, "utf8"));
  if (typeof identitySecret !== "string" || !identitySecret || roomId !== binding.roomId) throw new Error("Saved connection must match the bound room.");
  const inputs = {};
  for (const stage of stages) if (values[stage]) inputs[stage] = await readFile(values[stage]);

  async function call(name, args) {
    const response = await fetch(new URL("/mcp", origin), { redirect: "error", signal: AbortSignal.timeout(15_000), method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + identitySecret },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { roomId, ...args } } }) });
    const result = (await response.json()).result;
    if (!response.ok || result?.isError || !result?.structuredContent) {
      throw new Error(`${name} did not return a confirmed result. Replay the same files to recover any committed writes.`);
    }
    return result.structuredContent;
  }
  const prepare = values["work-revision"] !== undefined;
  const sourceProofPath = values["source-proof"];
  if (sourceProofPath !== undefined && !prepare) throw new Error("A source proof belongs in the first exact release result.");
  let expectedBody;
  if (prepare) {
    if (typeof memberId !== "string" || !memberId) throw new Error("The saved connection needs the assigned release producer's memberId.");
    if (binding.completionEventId !== undefined || !/^\d+$/.test(values["work-revision"])) {
      throw new Error("Supply a release binding without a completion event, and its exact work revision.");
    }
    const path = values["verify-path"];
    if (!/^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(path)) throw new Error("Expected a same-origin verification path.");
    const options = { redirect: "error", signal: AbortSignal.timeout(10_000) };
    const readVersion = async () => {
      const response = await fetch(new URL("/api/version", origin), options);
      if (!response.ok) throw new Error("Serving version was unavailable.");
      return (await response.json()).sourceRevision;
    };
    const before = await readVersion();
    if (before !== binding.candidateRevision) throw new Error("Verify the exact serving candidate before preparing review.");
    const proof = await fetch(new URL(path, origin), options);
    if (!proof.ok) throw new Error("Live verification URL was unavailable.");
    const verificationDigest = "sha256:" + hash(Buffer.from(await proof.arrayBuffer()));
    let sourceProof, jwks;
    if (sourceProofPath !== undefined) {
      sourceProof = JSON.parse(await readFile(sourceProofPath, "utf8"));
      const keys = await fetch(new URL("/.well-known/jwks.json", origin), options);
      if (!keys.ok) throw new Error("Serving source proof verification key was unavailable.");
      jwks = await keys.json();
    }
    const after = await readVersion();
    if (after !== before) throw new Error("Serving revision changed while collecting review evidence.");
    const body = prepareReleaseReview({ inputs, candidateRevision: binding.candidateRevision, origin, verificationPath: path,
      servingRevision: after, verificationDigest, binding, sourceProof, jwks });
    if (sourceProofPath !== undefined) expectedBody = body;
    binding = await submitReleaseReview({ binding, expectedRevision: Number(values["work-revision"]), producerId: memberId, body, call });
  }
  async function handoffSmoke({ candidateRevision, parentWorkItemId, completionEventId, criteria, ...assignment }) {
    const version = await fetch(new URL("/api/version", origin), { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!version.ok || (await version.json()).sourceRevision !== candidateRevision) {
      throw new Error("Post-deploy smoke handoff is waiting for the exact serving revision.");
    }
    const selected = await call("room_read_result", { workItemId: parentWorkItemId, completionEventId });
    if (selected.scope?.workVisibility !== "room" || selected.selection?.status !== "current" || selected.workThread?.releaseChecks?.checks
      .find(check => check.stage === "deploy" && check.status === "passed")?.evidenceMessageId !== assignment.sourceMessageId) {
      throw new Error("Post-deploy smoke handoff is waiting for the current deploy receipt.");
    }
    const result = await call("room_propose_work", { ...assignment, title: "Run post-deploy smoke test",
      definitionOfDone: `Candidate revision: ${candidateRevision}
Release Work Thread: ${origin.origin}/#pr-record/work/${encodeURIComponent(parentWorkItemId)}

${criteria}`,
      mode: "read", independentVerificationRequired: true, ownerDecisionRequired: false });
    return { workItemId: assignment.workItemId, eventId: result.eventId, duplicate: result.duplicate === true };
  }
  const output = await attachReleaseReceipts({ binding, inputs, requirePreparedEvidence: prepare && expectedBody === undefined, expectedBody,
    readResult: args => call("room_read_result", args), handoffSmoke,
    lookup: values.recover || prepare ? args => call("room_receipt", args) : undefined,
    post: async args => confirmedReceipt(await call("room_post_message", args), args.id) });
  console.log(JSON.stringify(prepare ? { ...output, binding } : output));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
