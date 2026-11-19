#!/usr/bin/env node
import { closeSync, existsSync, readSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { openRequestJournal, runRequestQueue } from "../client/request-runner.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { assertPrivatePath, openPrivateRead, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";
import { collectAffectedEvidence, inspectAffectedCheckout } from "./desktop-affected.mjs";

const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const fields = ["version", "origin", "roomId", "memberId", "worktree", "workItemId", "head", "base", "requesters"];
const refusals = new Set(["worktree_mismatch", "checkout_not_pinned_clean_head", "baseline_not_ancestor"]);

export function affectedRequestHost(policy) {
  if (!policy || Object.keys(policy).length !== fields.length || !fields.every(key => Object.hasOwn(policy, key))
    || policy.version !== 1 || typeof policy.origin !== "string" || !policy.origin || !validId(policy.roomId) || !validId(policy.memberId) || !validId(policy.workItemId)
    || !sha(policy.head) || !sha(policy.base) || typeof policy.worktree !== "string" || !isAbsolute(policy.worktree)
    || !Array.isArray(policy.requesters) || !policy.requesters.length || policy.requesters.length > 20
    || new Set(policy.requesters).size !== policy.requesters.length || !policy.requesters.every(validId))
    throw Error("invalid_local_affected_policy");
  const worktree = realpathSync(policy.worktree);
  const allowRequest = request => request.recipientId === policy.memberId && policy.requesters.includes(request.requesterId);
  const selectRequest = request => request.workItemId === policy.workItemId;
  const body = `mac affected ${policy.head}`;
  const execute = async ({ request, messages, preparation, signal }) => {
    const opened = messages.find(item => item.kind === "opened" && item.eventId === request.openingEventId);
    if (!allowRequest(request) || !selectRequest(request) || request.contextEventId !== request.openingEventId
      || opened?.message?.authorId !== request.requesterId || opened.message?.body !== body
      || preparation.work?.id !== policy.workItemId || !Number.isSafeInteger(preparation.work.revision)) {
      return { body: JSON.stringify({ kind: "desktop_affected_tests", status: "refused", reason: "expected_exact_opening_command" }) };
    }
    try {
      const result = await collectAffectedEvidence({ worktree, base: policy.base, expectedHead: policy.head,
        workRevision: preparation.work.revision, signal });
      return { body: JSON.stringify(result) };
    } catch (error) {
      signal.throwIfAborted();
      return { body: JSON.stringify({ kind: "desktop_affected_tests", status: "refused",
        reason: refusals.has(error.message) ? error.message : "local_check_unavailable" }) };
    }
  };
  return { allowRequest, selectRequest, execute };
}

async function main([path, connectionDirectory, ...extra]) {
  const approvalDigest = /^--approval-digest=([0-9a-f]{64})$/.exec(extra[0] ?? "")?.[1];
  if (extra.length > 1 || (extra.length === 1 && !approvalDigest) || !isAbsolute(path ?? "") || !isAbsolute(connectionDirectory ?? ""))
    throw Error("Usage: node scripts/run-desktop-affected-room.mjs /absolute/private/affected.json /absolute/connection-directory [--approval-digest=SHA256]");
  const directory = dirname(realpathSync(path));
  assertPrivatePath(directory, true);
  let policy;
  if (approvalDigest) {
    const fd = openPrivateRead(path);
    try {
      const buffer = Buffer.alloc(8193);
      const bytes = buffer.subarray(0, readSync(fd, buffer));
      if (bytes.length > 8192 || createHash("sha256").update(bytes).digest("hex") !== approvalDigest)
        throw Error("affected_policy_changed");
      policy = JSON.parse(bytes.toString("utf8"));
    } finally { closeSync(fd); }
  } else policy = readPrivateJson(path, 8192);
  const connection = readAgentConnection(connectionDirectory);
  if (["origin", "roomId", "memberId"].some(key => policy[key] !== connection[key])) throw Error("room_connection_changed");
  const host = affectedRequestHost(policy);
  // Confirm readiness before accepting requests. Re-check at execution after
  // any time spent waiting, because the active checkout can still change.
  if (approvalDigest) await inspectAffectedCheckout({
    worktree: realpathSync(policy.worktree), base: policy.base, expectedHead: policy.head
  });
  const owner = new WatchJournal(join(directory, "watch"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const client = new RoomAgentClient(connection), sessionId = randomUUID();
  const report = (state, fields = {}) => client.reportMacCapability({ sessionId, state, ...fields },
    { signal: AbortSignal.timeout(2500) }).catch(() => null);
  const checkout = { worktree: realpathSync(policy.worktree), base: policy.base, expectedHead: policy.head };
  const capability = { workItemId: policy.workItemId, head: policy.head, base: policy.base, requesters: policy.requesters };
  let nextReport = 0, reportedReady = false;
  let db;
  try {
    const journal = join(directory, "requests.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { assertPrivatePath(journal + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    db = openRequestJournal(journal);
    let ready = false;
    await runRequestQueue({ connection, db, ...host, signal: controller.signal, intervalMs: 2000,
      async onPoll() {
        if (!ready) console.log(JSON.stringify({ status: "watching", workItemId: policy.workItemId, head: policy.head }));
        ready = true;
        if (!approvalDigest || controller.signal.aborted || Date.now() < nextReport) return;
        nextReport = Date.now() + 8000;
        try { await inspectAffectedCheckout(checkout); }
        catch {
          if (reportedReady) await report("unavailable");
          reportedReady = false;
          return;
        }
        if (!controller.signal.aborted) reportedReady = (await report("ready", capability))?.state === "ready";
      },
      emit: event => console.log(JSON.stringify({ status: event.status, requestId: event.requestId,
        requestMessageId: event.receipt?.requestMessageId ?? event.requestMessageId,
        sequence: event.receipt?.sequence, hostExecuted: event.hostExecuted })),
    });
  } finally {
    if (approvalDigest) await report("stopped");
    db?.close(); owner.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
