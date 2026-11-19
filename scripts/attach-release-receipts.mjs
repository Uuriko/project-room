import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const revision = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash("sha256").update(value).digest("hex");
const stages = ["build", "browser", "deploy"];

function stageEvidence(stage, value, candidate) {
  if (stage === "build" && value?.sourceCommit === candidate && value.verified === true
      && revision.test(value.sourceTree) && /^[a-f0-9]{64}$/.test(value.manifestSha256)
      && integer(value.files) && value.files > 0) {
    const { sourceCommit, sourceTree, manifestSha256, files, verified } = value;
    return { status: "passed", summary: `Runtime package verified, ${files} files.`,
      proof: { sourceCommit, sourceTree, manifestSha256, files, verified } };
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

export async function attachReleaseReceipts({ binding, inputs, readResult, lookup, post }) {
  const { workItemId, completionEventId, candidateRevision } = binding;
  if (typeof workItemId !== "string" || !workItemId || typeof completionEventId !== "string" || !completionEventId
      || !revision.test(candidateRevision)) throw new Error("Expected a work item, exact completion event and 40-hex candidate.");

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
  const previouslyAttached = selected.workThread?.releaseChecks?.checks ?? [];
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
    checks: Object.fromEntries(prepared.map(({ stage, check }) => [stage, check])) };
  const reportBody = "room-release-checks/1\n" + JSON.stringify(report);
  const published = await send("release-checks-" + hash(JSON.stringify([workItemId, reportBody])), reportBody);
  return { candidateRevision, completionEventId, report: published, evidence };
}

export function confirmedReceipt(saved, id) {
  if (saved.messageId !== id || !Number.isSafeInteger(saved.sequence) || saved.sequence <= 0
      || saved.status !== (saved.duplicate === true ? "duplicate" : "posted")) {
    throw new Error("Unexpected receipt. Replay the same files.");
  }
  return { messageId: saved.messageId, sequence: saved.sequence, duplicate: saved.duplicate === true };
}

async function main() {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(["binding", "build", "browser", "deploy"].map(name => [name, { type: "string" }])),
    recover: { type: "boolean", default: false }
  } });
  const origin = new URL(process.env.ROOM_RELEASE_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.href !== origin.origin + "/") {
    throw new Error("ROOM_RELEASE_ORIGIN must be an HTTPS origin.");
  }
  const binding = JSON.parse(await readFile(values.binding, "utf8"));
  const { identitySecret, roomId } = JSON.parse(await readFile(process.env.ROOM_RELEASE_CONNECTION, "utf8"));
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
  const output = await attachReleaseReceipts({ binding, inputs,
    readResult: args => call("room_read_result", args),
    lookup: values.recover ? args => call("room_receipt", args) : undefined,
    post: async args => confirmedReceipt(await call("room_post_message", args), args.id) });
  console.log(JSON.stringify(output));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
