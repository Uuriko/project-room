import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { validId } from "../src/events.js";
import { confirmsAgentCommand } from "./work-actions.mjs";
import { sessionRecord } from "../src/work-item-session.js";
import { requestRunMayExecute } from "../src/request-run-policy.js";

// The command comes from a trusted local operator, never from room text.
// This is process supervision, NOT a filesystem/network/credential sandbox.
export async function runLocalSession({ client, roomId, memberId, workItemId, runId,
  expectedRevision, command, args = [], cwd, env = {}, maxRuntimeMs,
  maxOutputBytes = 65536, pollMs = 1000, killGraceMs = 1000, input = "", requestGuard = null, signal }) {
  const requestRunMode = workItemId === null && requestGuard !== null;
  if (process.platform === "win32" || ![roomId, memberId, runId].every(validId) || !(validId(workItemId) || requestRunMode)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || runId.length > 110
    || typeof command !== "string" || !isAbsolute(command) || typeof cwd !== "string" || !isAbsolute(cwd)
    || !Array.isArray(args) || args.some(arg => typeof arg !== "string")
    || !env || Array.isArray(env) || typeof env !== "object" || Object.values(env).some(value => typeof value !== "string")
    || !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 300000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1048576
    || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 10000
    || typeof input !== "string" || Buffer.byteLength(input) > 65536
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 5000) throw new Error("Invalid local run configuration");
  if (requestGuard !== null && (!requestGuard || Array.isArray(requestGuard)
    || Object.keys(requestGuard).length !== 3
    || !validId(requestGuard.requestMessageId) || !validId(requestGuard.contextEventId)
    || !Number.isSafeInteger(requestGuard.instructionsRevision) || requestGuard.instructionsRevision < 0))
    throw new Error("Invalid request guard");
  // Copy the inspected selection once. Never adopt a newer request mid-run.
  const guard = requestGuard && structuredClone(requestGuard);
  const identity = { roomId, memberId };
  const claim = requestRunMode ? { id: `${runId}:start`, type: "request_run.claimed", data: {
    ...guard, expectedRevision, runId, maxRuntimeMs, maxOutputBytes } }
    : { id: `${runId}:start`, type: "session.started", data: { workItemId, expectedRevision,
    budget: { maxRuntimeMs, maxAttempts: 1, maxConcurrent: 1 } } };
  const read = async () => {
    const snapshot = await client.snapshot({ signal: AbortSignal.timeout(Math.min(5000, maxRuntimeMs)) });
    if (snapshot.roomId !== roomId || snapshot.viewerId !== memberId
      || snapshot.state.members[memberId]?.active !== true) throw new Error("Run identity unavailable");
    const item = snapshot.state.workItems[workItemId];
    const request = guard && snapshot.state.replyRequests?.[guard.requestMessageId];
    const requestCurrent = !guard || Boolean(request && request.status === "open"
      && request.recipientId === memberId && request.workItemId === workItemId
      && request.contextEventId === guard.contextEventId
      && (snapshot.state.room.charter?.revision ?? 0) === guard.instructionsRevision);
    if (requestRunMode) {
      const run = snapshot.state.requestRuns?.[guard.requestMessageId];
      if (run && (!Number.isSafeInteger(run.revision) || run.revision < 1
        || run.requestMessageId !== guard.requestMessageId || run.memberId !== memberId
        || !validId(run.runId) || !["running", "stop_requested", "succeeded", "failed", "cancelled"].includes(run.status)))
        throw new Error("Invalid request run state");
      const owns = run?.runId === runId;
      if (owns && (run.maxRuntimeMs !== maxRuntimeMs || run.maxOutputBytes !== maxOutputBytes
        || run.contextEventId !== guard.contextEventId || run.instructionsRevision !== guard.instructionsRevision))
        throw new Error("Request run does not match claim");
      return { revision: run?.revision ?? 0,
        status: !run || ["succeeded", "failed", "cancelled"].includes(run.status) ? "queued" : run.status === "running" ? "processing" : "suspended",
        worker_member_id: owns ? memberId : null, stop_requested_at: run?.status === "stop_requested" ? run.updatedAt : null,
        deadlineAt: run?.deadlineAt,
        requestCurrent: requestCurrent && !snapshot.state.agentHalts?.[memberId],
        executionAllowed: owns && requestRunMayExecute(run, request, guard.instructionsRevision, new Date().toISOString()) };
    }
    return item ? { ...item, ...sessionRecord(item), requestCurrent } : null;
  };
  if (signal?.aborted) return { status: "not_started", reason: "cancelled" };
  const initial = await read();
  if (initial && !initial.requestCurrent) return { status: "not_started", reason: "request_changed" };
  if (!initial || initial.status !== "queued" || initial.revision !== expectedRevision || initial.stop_requested_at)
    return { status: "not_started", reason: "session_changed" };
  const receipt = await client.command(claim, { signal: AbortSignal.timeout(5000) });
  // A replay proves a prior claim, not that its process never ran. Never rerun it.
  if (!confirmsAgentCommand(receipt, claim, identity) || receipt.duplicate)
    return { status: "not_started", reason: "claim_requires_reconciliation", claim };
  let child, timer, killTimer, monitor, checking = false, finished = false, reason = null, bytes = 0;
  const chunks = [], stdoutChunks = [], started = Date.now();
  const killGroup = sig => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const stop = why => {
    if (finished) return;
    reason ??= why;
    if (!child) return;
    killGroup("SIGTERM");
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), killGraceMs);
  };
  const cancelled = () => stop("cancelled");
  let exit = { code: null, signal: null };
  try {
    const current = await read();
    if (signal?.aborted) stop("cancelled");
    else if (Date.now() - started >= maxRuntimeMs) stop("runtime_limit");
    else if (!current || current.worker_member_id !== memberId || current.status !== "processing" || current.stop_requested_at)
      stop("session_changed");
    else if (!current.requestCurrent) stop("request_changed");
    else if (requestRunMode && !current.executionAllowed) stop("runtime_limit");
    if (!reason) {
      child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise(resolve => {
        child.once("error", () => { reason ??= "process_start_failed"; });
        child.once("close", (code, sig) => resolve({ code, signal: sig }));
      });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) { stop("output_limit"); return; }
        chunks.push(chunk);
        if (stream === child.stdout) stdoutChunks.push(chunk);
      });
      child.stdin.on("error", () => stop("input_unavailable"));
      child.stdin.end(input);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      const remaining = Math.min(maxRuntimeMs - (Date.now() - started), requestRunMode ? Date.parse(current.deadlineAt) - Date.now() : Infinity);
      timer = setTimeout(() => stop("runtime_limit"), Math.max(1, remaining));
      monitor = setInterval(async () => {
        if (checking || reason) return;
        checking = true;
        try {
          const item = await read();
          if (!item || item.worker_member_id !== memberId || !["processing", "active"].includes(item.status)
            || item.stop_requested_at || item.handoff?.haltAll) stop("room_stop");
          else if (!item.requestCurrent) stop("request_changed");
          else if (requestRunMode && !item.executionAllowed) stop("runtime_limit");
        } catch { stop("access_unavailable"); }
        finally { checking = false; }
      }, pollMs);
      exit = await closed;
    }
  } catch { reason ??= "access_unavailable"; }
  finally {
    finished = true;
    clearTimeout(timer); clearTimeout(killTimer); clearInterval(monitor);
    signal?.removeEventListener("abort", cancelled);
    // Also remove children that outlive a normally exited parent in this group.
    killGroup("SIGKILL");
  }
  const status = !reason && exit.code === 0 ? "done" : "failed";
  let recording = "unconfirmed", terminalCommand = null;
  try {
    const current = await read();
    if (current?.worker_member_id === memberId && ["processing", "active", "suspended"].includes(current.status)) {
      terminalCommand = requestRunMode ? { id: `${runId}:finish`, type: "request_run.finished",
        data: { requestMessageId: guard.requestMessageId, runId, expectedRevision: current.revision, status: status === "done" ? "succeeded" : "failed" } }
        : { id: `${runId}:finish`, type: "session.stopped",
        data: { workItemId, expectedRevision: current.revision, status } };
      const saved = await client.command(terminalCommand, { signal: AbortSignal.timeout(5000) });
      if (confirmsAgentCommand(saved, terminalCommand, identity)) recording = "recorded";
    }
  } catch { /* Preserve exact final operation for reconciliation; do not retry a process. */ }
  return { status, reason: reason ?? (exit.code === 0 ? "process_exited" : "process_failed"),
    ...exit, output: Buffer.concat(chunks).toString("utf8"), stdout: Buffer.concat(stdoutChunks).toString("utf8"), outputBytes: bytes, recording, terminalCommand,
    workCompleted: false, processSandboxed: false };
}
