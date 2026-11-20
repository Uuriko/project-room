import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicPrivateJson, ensurePrivateDirectory, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";
import { WatchJournal } from "./watch-journal.mjs";

function reviewTarget(connection, selection) {
  const selected = selection?.nextRead ?? selection;
  const args = selected?.arguments;
  if (selected?.tool !== "room_read_result" || args?.roomId !== connection.roomId
    || ![connection.memberId, args?.workItemId, args?.completionEventId].every(validId)
    || args.draftMessageId !== undefined) throw new Error("Choose an exact completion from Room Next or a Room wake");
  return { workItemId: args.workItemId, completionEventId: args.completionEventId };
}

function readRun(filename) {
  try { return readPrivateJson(filename); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

function acceptedVerdict(value) {
  return ["pass", "fail"].includes(value?.result)
    && typeof value.summary === "string" && value.summary.trim().length > 0 && value.summary.length <= 2000;
}

// Both managed inputs use this entry. The existing process lock protects
// preparation, while the committed intent fences a restart after launch.
export async function runManagedExactReview({ connection, selection, journalDirectory, client, execute, submit, receipt, reportRuntime, signal }) {
  const target = reviewTarget(connection, selection);
  // Completion IDs are immutable; the validated evidence digest is retained in the write basis.
  const key = createHash("sha256").update(JSON.stringify([connection.origin, connection.roomId,
    connection.memberId, target.workItemId, target.completionEventId])).digest("hex");
  const operationId = "managed-review-" + key;
  const directory = join(journalDirectory, key);
  ensurePrivateDirectory(journalDirectory, { recursive: true });
  ensurePrivateDirectory(directory);
  let owner;
  try { owner = new WatchJournal(directory); }
  catch (error) {
    if (error.code === "already_watching") return { status: "already_claimed", operationId };
    throw error;
  }

  const reports = [];
  const publish = (record, phase) => {
    if (!record?.basis || !reportRuntime) return;
    const { workItemId, completionEventId, evidenceVersion, expectedRevision } = record.basis;
    reports.push(Promise.resolve().then(() => reportRuntime({ workItemId, completionEventId, evidenceVersion,
      expectedRevision, attemptId: record.attemptId, phase })).catch(() => {}));
  };
  try {
    const filename = join(directory, "review-run.json");
    const saved = readRun(filename);
    const stale = provider => ({ status: "stale_revision", operationId, provider,
      nextRead: { tool: "room_read_result", arguments: { roomId: connection.roomId, workItemId: target.workItemId } } });
    if (saved?.phase === "provider_start_uncertain") {
      publish(saved, saved.providerStarted ? "started" : "start_unknown");
      return { status: saved.phase, operationId };
    }
    if (saved?.phase === "stale_revision") return stale(saved.provider);
    if (saved && !["verdict_prepared", "recorded"].includes(saved.phase)) throw new Error("Unknown managed review journal phase");
    let run = saved;
    const writeRun = value => atomicPrivateJson(filename, value);
    const finish = value => {
      if (!validId(value?.eventId) || !Number.isSafeInteger(value.sequence) || value.sequence < 1)
        throw new Error("Unconfirmed Room verdict");
      const { eventId, sequence } = value;
      writeRun({ ...run, phase: "recorded", eventId, sequence });
      return { status: "recorded", operationId, eventId, sequence, provider: run.provider };
    };
    if (run) {
      if (run.providerStarted) publish(run, "started");
      const original = await receipt(operationId, { signal });
      if (original) return finish(original);
      if (run.phase === "recorded") return { status: "verdict_receipt_unavailable", operationId };
    } else {
      await execute.prepare?.({ signal });
      signal?.throwIfAborted();
      const { workItemId, completionEventId } = target;
      const packet = await client.workResult(workItemId, { completionEventId, signal });
      const action = packet.review?.action;
      if (packet.viewerId !== connection.memberId || action?.tool !== "room_record_verification"
        || packet.current.completionEventId !== completionEventId || packet.current.next.memberId !== connection.memberId)
        return { status: "review_unavailable", operationId };
      const args = { ...action.arguments, requestId: operationId };
      const evidence = { criteria: packet.review.criteria, result: packet.result.text?.body ?? packet.result.receipt,
        priorFinding: packet.workThread?.correction?.summary ?? null, completionEventId, evidenceVersion: args.evidenceVersion };
      signal?.throwIfAborted();
      const attempt = { phase: "provider_start_uncertain", basis: args, attemptId: randomUUID(), providerStarted: false };
      writeRun(attempt);
      publish(attempt, "claimed");
      const confirmProvider = () => {
        if (attempt.providerStarted) return;
        attempt.providerStarted = true;
        writeRun(attempt);
        publish(attempt, "started");
      };
      const uncertain = () => {
        if (!attempt.providerStarted) publish(attempt, "start_unknown");
        return { status: "provider_start_uncertain", operationId };
      };
      let verdict;
      try { verdict = await execute(evidence, { signal, confirmProvider }); }
      catch { return uncertain(); }
      if (!acceptedVerdict(verdict)) return uncertain();
      // A returned provider session with model usage is evidence even when
      // the host could not report it earlier in the stream.
      if (verdict.provider?.sessionId && verdict.provider.usage?.output_tokens > 0) confirmProvider();
      run = { ...attempt, phase: "verdict_prepared",
        args: { ...args, result: verdict.result, summary: verdict.summary }, provider: verdict.provider };
      writeRun(run);
    }
    try { return finish(await submit(run.args, { signal })); }
    catch (error) {
      if (error.code === "stale_revision") {
        writeRun({ ...run, phase: "stale_revision" });
        return stale(run.provider);
      }
      const original = await receipt(operationId, { signal });
      return original ? finish(original) : { status: "verdict_unconfirmed", operationId, provider: run.provider };
    }
  } finally { owner.close(); await Promise.allSettled(reports); }
}
