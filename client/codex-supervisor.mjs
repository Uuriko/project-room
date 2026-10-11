import { setTimeout as delay } from "node:timers/promises";
import { RoomAgentClient } from "./room-agent.mjs";
import { WatchJournal } from "./watch-journal.mjs";
import { runCodexSharedAssistant } from "./codex-shared-assistant.mjs";

const recoverable = new Set(["working", "unknown", "resume_requested", "pause_requested", "cancel_requested"]);
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
  let rpc, control, monitorError, failures = 0;
  const scope = JSON.stringify([connection.origin, connection.roomId, connection.memberId]);
  const state = (status, extra = {}) => emit({ type: "host_status", status, ...extra });
  const pause = ms => delay(ms, undefined, { signal: controller.signal }).catch(error => { if (!controller.signal.aborted) throw error; });
  try {
    const client = new RoomAgentClient(connection);
    db.exec("CREATE TABLE IF NOT EXISTS codex_supervisor_retry (scope TEXT NOT NULL, run_id TEXT NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(scope,run_id))");
    control = setInterval(() => {
      try { if (owner.shouldStop()) abort(); }
      catch (error) { monitorError = error; abort(); }
    }, Math.min(pollMs, 1000));
    state("watching_room", { providerAuthentication: "unverified" });
    while (!controller.signal.aborted) {
      try {
        const snapshot = await client.assistant(undefined, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        owner.health("watching"); failures = 0;
        const owned = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_shared_runs'").get()
          ? new Set(db.prepare("SELECT attempt_id FROM codex_shared_runs").all().map(row => row.attempt_id)) : new Set();
        const assigned = snapshot.runs.filter(run => run.coordinatorMemberId === connection.memberId);
        const recovering = assigned.filter(run => owned.has(run.attemptId) && recoverable.has(run.status));
        // An unresolved owned runtime gets priority over new execution. Do not
        // pile new work onto a profile with an ambiguous prior tool outcome.
        const candidates = recovering.length ? recovering : assigned.filter(run => run.status === "queued" && !run.attemptId && !run.sourceDeleted);
        candidates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
        const run = candidates.find(row => (db.prepare("SELECT retry_at FROM codex_supervisor_retry WHERE scope=? AND run_id=?").get(scope, row.id)?.retry_at ?? 0) <= Date.now());
        if (!run) { await pause(pollMs); continue; }
        try {
          if (!rpc) { rpc = await connect(scopedCodexThreads(db, connection)); state("protocol_qualified", { providerAuthentication: "unverified" }); }
          if (controller.signal.aborted) break;
          state("running", { runId: run.id, recovering: Boolean(run.attemptId) });
          const result = await runCodexSharedAssistant({ connection, db, rpc, cwd, policy, runId: run.id,
            signal: controller.signal, timeoutMs, emit });
          db.prepare("DELETE FROM codex_supervisor_retry WHERE scope=? AND run_id=?").run(scope, run.id);
          state("settled", { runId: run.id, runStatus: result.result.status, resultMessageId: result.result.resultMessageId ?? null });
        } catch (error) {
          if (controller.signal.aborted) break;
          const count = (db.prepare("SELECT failures FROM codex_supervisor_retry WHERE scope=? AND run_id=?").get(scope, run.id)?.failures ?? 0) + 1;
          const retryAt = Date.now() + Math.min(retryMaxMs, pollMs * 2 ** Math.min(count, 10));
          db.prepare("INSERT INTO codex_supervisor_retry VALUES(?,?,?,?) ON CONFLICT(scope,run_id) DO UPDATE SET failures=excluded.failures,retry_at=excluded.retry_at").run(scope, run.id, count, retryAt);
          state("recovery_pending", { runId: run.id, retryAt, code: error.code ?? "runtime_or_room_unavailable" });
          await rpc?.close(); rpc = undefined;
        }
        // Bound repeated revocation/conflict reads too, not only idle polling.
        await pause(pollMs);
      } catch (error) {
        if (controller.signal.aborted) break;
        owner.health("retrying"); failures++;
        const retryMs = Math.min(retryMaxMs, pollMs * 2 ** Math.min(failures, 10));
        state("retrying_room", { retryMs, code: error.code ?? "room_unavailable" });
        await pause(retryMs);
      }
    }
  } finally {
    clearInterval(control); signal?.removeEventListener("abort", abort);
    try { await rpc?.close(); } finally {
      try { owner.health("stopped"); } catch (error) { monitorError ??= error; } finally { owner.close(); }
    }
    state("stopped");
  }
  if (monitorError) throw monitorError;
}
