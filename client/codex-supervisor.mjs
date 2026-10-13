import { setTimeout as delay } from "node:timers/promises";
import { RoomAgentClient } from "./room-agent.mjs";
import { WatchJournal } from "./watch-journal.mjs";
import { runCodexSharedAssistant, initSharedRunJournal, sharedRunScope } from "./codex-shared-assistant.mjs";

const recoverable = new Set(["working", "unknown", "resume_requested", "pause_requested", "cancel_requested"]);
// Adapted from the existing PR2662: refusals require reconnection, not new turns.
const permanentCodes = new Set(["unauthenticated", "invalid_token", "token_revoked", "origin_denied", "host_denied", "forbidden", "not_a_member", "member_removed"]);
export const isPermanentRoomError = error => error?.status === 401 || error?.status === 403 || permanentCodes.has(error?.code);
const isClaimRace = error => ["assistant_revision_conflict", "assistant_attempt_changed", "assistant_run_owned"].includes(error?.code);
// The cap bounds our backoff only. It must never shorten the server's minimum.
export const retryDelay = (error, backoffMs) => Math.max(backoffMs,
  Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0);
export class ReconnectAgentError extends Error {
  constructor(cause) {
    super("Room refused this agent's connection; reconnect this agent", { cause });
    this.code = "reconnect_agent";
  }
}
export function scopedCodexThreads(db, connection) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_runtime_attempts'").get()) return [];
  return db.prepare("SELECT binding,thread_id FROM codex_runtime_attempts WHERE thread_id IS NOT NULL").all()
    .filter(row => { const binding = JSON.parse(row.binding); return ["origin", "roomId", "memberId"].every(key => binding[key] === connection[key]); })
    .map(row => row.thread_id);
}

// Shared asks are not AssignmentWatcher reply requests. Poll their authoritative
// projection: generic room-event wakes alone miss assistant-only changes.
// Reuse the watcher lifetime ownership lock and stop control; execution ownership
// remains the existing shared-attempt journal and server claim, never a new lease.
export async function superviseCodexRoom({ connection, db, directory, connect, cwd, policy,
  signal, emit = () => {}, pollMs = 2000, retryMaxMs = 30000, timeoutMs = 300000 }) {
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 30000 || !Number.isInteger(retryMaxMs) || retryMaxMs < pollMs || retryMaxMs > 300000)
    throw new Error("Invalid supervisor polling/backoff interval");
  const owner = new WatchJournal(directory), controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let rpc, control, monitorError, authError, failures = 0;
  const scope = sharedRunScope(connection);
  const state = (status, extra = {}) => emit({ type: "host_status", status, ...extra });
  const pause = async ms => {
    const deadline = performance.now() + ms;
    // Node otherwise turns an overflowing timeout into a 1ms retry.
    while (!controller.signal.aborted && performance.now() < deadline)
      await delay(Math.min(2147483647, Math.ceil(deadline - performance.now())), undefined, { signal: controller.signal })
        .catch(error => { if (!controller.signal.aborted) throw error; });
  };
  try {
    const client = new RoomAgentClient(connection);
    initSharedRunJournal(db);
    db.exec("CREATE TABLE IF NOT EXISTS codex_supervisor_retry (scope TEXT NOT NULL, run_id TEXT NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(scope,run_id))");
    control = setInterval(() => {
      try { if (owner.shouldStop()) abort(); }
      catch (error) { monitorError = error; abort(); }
    }, Math.min(pollMs, 1000));
    state("watching_room", { providerAuthentication: "unverified" });
    while (!controller.signal.aborted) {
      try {
        const owned = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_shared_runs'").get()
          ? new Set(db.prepare("SELECT attempt_id FROM codex_shared_runs").all().map(row => row.attempt_id)) : new Set();
        let cursor = null, recovering = null, queued = null, hasRecovery = false;
        const ready = row => (db.prepare("SELECT retry_at FROM codex_supervisor_retry WHERE scope=? AND run_id=?").get(scope, row.id)?.retry_at ?? 0) <= Date.now();
        // Reconcile local attempts independently of backlog size or visibility.
        // Missing/revoked work is not evidence that its external effects ended.
        const pending = db.prepare("SELECT id,attempt_id,run_id,run_created_at FROM codex_shared_runs WHERE scope=? AND settled=0 ORDER BY rowid").all(scope);
        for (const record of pending) {
          const exact = await client.assistant(undefined, { runId: record.run_id,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          const row = exact.runs[0];
          if (String(row.createdAt) !== record.run_created_at || row.stopOutcome === "attempt_revoked"
            || row.attemptId !== null && row.attemptId !== record.attempt_id)
            throw Object.assign(new Error("Owned execution needs reconciliation"), { code: "assistant_recovery_unresolved" });
          if (["done", "cancelled", "failed"].includes(row.status)) {
            db.prepare("UPDATE codex_shared_runs SET settled=1 WHERE id=?").run(record.id);
            continue;
          }
          if (row.coordinatorMemberId !== connection.memberId)
            throw Object.assign(new Error("Owned execution was reassigned"), { code: "assistant_recovery_unresolved" });
          if (recoverable.has(row.status) || row.status === "queued" && !row.attemptId) {
            hasRecovery = true;
            if (ready(row) && !recovering) recovering = row;
          }
        }
        if (!hasRecovery) do {
          const page = await client.assistant(undefined, { work: true, cursor,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          for (const row of page.runs) {
            if (row.coordinatorMemberId !== connection.memberId) continue;
            // Legacy pre-metadata records still recover through complete pages.
            if (owned.has(row.attemptId) && recoverable.has(row.status)) {
              hasRecovery = true;
              if (ready(row) && !recovering) recovering = row;
            } else if (ready(row) && !queued && row.status === "queued" && !row.attemptId && !row.sourceDeleted) queued = row;
          }
          cursor = page.nextCursor;
        } while (cursor !== null && !controller.signal.aborted);
        owner.health("watching"); failures = 0;
        // Retain only two candidates, not the entire backlog. A recovery still
        // in backoff blocks new work even when it appears on a later page.
        const run = hasRecovery ? recovering : queued;
        if (!run) { await pause(pollMs); continue; }
        try {
          if (!rpc) { rpc = await connect(scopedCodexThreads(db, connection)); state("protocol_qualified", { providerAuthentication: "unverified" }); }
          if (controller.signal.aborted) break;
          state("running", { runId: run.id, recovering: Boolean(run.attemptId) });
          const result = await runCodexSharedAssistant({ connection, db, rpc, cwd, policy, runId: run.id,
            signal: controller.signal, timeoutMs, emit });
          db.prepare("DELETE FROM codex_supervisor_retry WHERE scope=? AND run_id=?").run(scope, run.id);
          state("settled", { runId: run.id, runStatus: result.result.status, resultMessageId: result.result.resultMessageId ?? null });
          // Drain ready work immediately after settlement. The next scan still
          // reconciles owned attempts; an empty queue retains the idle pause.
          continue;
        } catch (error) {
          if (controller.signal.aborted) break;
          if (isPermanentRoomError(error)) { authError = error; break; }
          if (isClaimRace(error)) { state("skipped_owned_elsewhere", { runId: run.id }); await pause(pollMs); continue; }
          const count = (db.prepare("SELECT failures FROM codex_supervisor_retry WHERE scope=? AND run_id=?").get(scope, run.id)?.failures ?? 0) + 1;
          const retryAt = Date.now() + retryDelay(error, Math.min(retryMaxMs, pollMs * 2 ** Math.min(count, 10)));
          db.prepare("INSERT INTO codex_supervisor_retry VALUES(?,?,?,?) ON CONFLICT(scope,run_id) DO UPDATE SET failures=excluded.failures,retry_at=excluded.retry_at").run(scope, run.id, count, retryAt);
          state("recovery_pending", { runId: run.id, retryAt, code: error.code ?? "runtime_or_room_unavailable" });
          if (!(error?.status > 0)) { await rpc?.close(); rpc = undefined; }
          // A Room rate limit also applies to the next recovery/control read,
          // not just the next execution attempt.
          if (error.retryAfterMs > 0) await pause(retryDelay(error, pollMs));
        }
        // Bound repeated revocation/conflict reads too, not only idle polling.
        await pause(pollMs);
      } catch (error) {
        if (controller.signal.aborted) break;
        if (isPermanentRoomError(error)) { authError = error; break; }
        owner.health("retrying"); failures++;
        const retryMs = retryDelay(error, Math.min(retryMaxMs, pollMs * 2 ** Math.min(failures, 10)));
        state("retrying_room", { retryMs, code: error.code ?? "room_unavailable" });
        await pause(retryMs);
      }
    }
  } finally {
    clearInterval(control); signal?.removeEventListener("abort", abort);
    try { await rpc?.close(); } finally {
      try { owner.health("stopped"); } catch (error) { monitorError ??= error; } finally { owner.close(); }
    }
    if (authError) state("stopped_auth", { code: authError.code ?? `http_${authError.status}`, action: "reconnect_agent" });
    state("stopped");
  }
  if (monitorError) throw monitorError;
  if (authError) throw new ReconnectAgentError(authError);
}
