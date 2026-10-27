import { hasUnresolvedRequestIntents } from "./request-reconciliation.mjs";
import { validId } from "../src/events.js";
import { WatchJournal } from "./watch-journal.mjs";
import { runRequestQueue } from "./request-runner.mjs";
import { roomCodexHost } from "./codex-runtime.mjs";
import { scopedCodexThreads } from "./codex-supervisor.mjs";

// Explicit alternative to the shared-assistant supervisor, never a parallel
// consumer of its dedicated runtime. connect owns the existing profile lock.
// Room delivery is HTTPS; this supervisor needs no inbound port or VPN.
export async function superviseCodexRequests({ connection, db, directory, connect, cwd, policy,
  allowedRequesterIds, allowedRequestIds, signal, emit = () => {}, pollMs = 2000, timeoutMs = 300000,
  connectOnStart = false, runtimeFingerprint }) {
  if (!Array.isArray(allowedRequesterIds) || !allowedRequesterIds.length || allowedRequesterIds.length > 20
    || new Set(allowedRequesterIds).size !== allowedRequesterIds.length
    || !allowedRequesterIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)))
    throw new Error("Explicit requester member allowlist required");
  if (allowedRequestIds !== undefined && (!Array.isArray(allowedRequestIds) || !allowedRequestIds.length || allowedRequestIds.length > 20
    || new Set(allowedRequestIds).size !== allowedRequestIds.length || !allowedRequestIds.every(validId)))
    throw new Error("Choose 1 to 20 distinct valid request IDs");
  const selected = allowedRequestIds === undefined ? null : new Set(allowedRequestIds);
  if (typeof connect !== "function" || !Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000
    || policy?.approvalPolicy !== "never" || !["read-only", "workspace-write"].includes(policy?.sandbox))
    throw new Error("Explicit unattended runtime policy and polling interval required");
  const allowed = new Set(allowedRequesterIds), owner = new WatchJournal(directory), controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let rpc, host, monitorError, control, lastStatus;
  const state = (status, extra = {}) => {
    const event = { type: "host_status", status, ...extra }, key = JSON.stringify(event);
    if (key !== lastStatus) { lastStatus = key; emit(event); }
  };
  // An ambiguous prior invocation owns this workspace until reconciled. Do not
  // confuse server queue eligibility with permission to start a successor.
  const unresolved = () => {
    if (hasUnresolvedRequestIntents(db, connection, runtimeFingerprint)) return true;
    // Switching from shared asks must not abandon that mode's owned outcome.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_shared_runs'").get()) return false;
    const shared = db.prepare("SELECT attempt_id FROM codex_shared_runs WHERE publish IS NULL").all();
    if (!shared.length) return false;
    const runtime = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_runtime_attempts'").get()
      ? db.prepare("SELECT binding,state FROM codex_runtime_attempts").all() : [];
    return shared.some(record => {
      const attempts = runtime.filter(row => JSON.parse(row.binding).attemptId === record.attempt_id);
      return !attempts.length || attempts.some(row => !["completed", "interrupted", "failed"].includes(row.state));
    });
  };
  const requesterAllowed = request => allowed.has(request.requesterId) && request.recipientId === connection.memberId;
  const selectRequest = request => (!selected || selected.has(request.id)) && !unresolved();
  const executionAllowed = request => requesterAllowed(request) && (!selected || selected.has(request.id));
  const prepare = async () => {
    controller.signal.throwIfAborted();
    if (host) return;
    rpc = await connect(scopedCodexThreads(db, connection));
    controller.signal.throwIfAborted();
    host = roomCodexHost({ connection, db, rpc, cwd, policy, timeoutMs, emit, runtimeFingerprint, allowRequest: executionAllowed });
    state("protocol_qualified", { providerAuthentication: "unverified" });
  };
  const execute = Object.assign(async (input, options) => {
    controller.signal.throwIfAborted();
    // runRequestOnce rechecks the allowlist before claiming and invokes prepare
    // before persisting a new attempt. Its own signal also tracks Room controls.
    state("running", { runId: input.request.id });
    return host(input, options);
  }, { prepare });
  try {
    control = setInterval(() => {
      try { if (owner.shouldStop()) abort(); }
      catch (error) { monitorError = error; abort(); }
    }, Math.min(pollMs, 1000));
    state(unresolved() ? "recovery_pending" : "watching_room", { providerAuthentication: "unverified" });
    if (connectOnStart && !unresolved() && !controller.signal.aborted) await prepare();
    if (!controller.signal.aborted) await runRequestQueue({ connection, db, execute, allowRequest: requesterAllowed, selectRequest,
      signal: controller.signal, intervalMs: pollMs, onPoll: () => {
        owner.health("watching"); state(unresolved() ? "recovery_pending" : "watching_room");
      }, onMetrics: metrics => emit({ status: "request_metrics", metrics }), emit: event => {
        if (event.status === "connection_unavailable") { owner.health("retrying"); state("retrying_room"); }
        else if (event.status === "delivered") {
          state("settled", { runId: event.requestId }); emit(event);
        } else if (event.status === "needs_attention") {
          state("recovery_pending", { runId: event.requestMessageId }); emit(event);
        }
      } });
  } finally {
    clearInterval(control); signal?.removeEventListener("abort", abort);
    try { await rpc?.close(); } finally {
      try { owner.health("stopped"); } finally { owner.close(); }
      state("stopped");
    }
  }
  if (monitorError) throw monitorError;
}
