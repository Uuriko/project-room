import { setTimeout as delay } from "node:timers/promises";

// Discovery only. The existing runner owns durable claims, execution journals,
// stop handling and publication. Never steal or restart an existing attempt.
export async function watchSharedAssistant({ client, memberId, execute, signal,
  pollMs = 1000, readTimeoutMs = 15000, emit = () => {} }) {
  if (!memberId || typeof execute !== "function" || !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 30000
    || !Number.isInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > 120000)
    throw new Error("Invalid shared assistant watcher configuration");
  let lastState;
  const status = state => {
    if (state !== lastState) { emit({ type: "watch_status", state }); lastState = state; }
  };
  try {
    while (!signal?.aborted) {
      // Read errors end this process. A supervisor can reconnect, but execution
      // errors require explicit reconciliation with the original journal.
      const timeout = AbortSignal.timeout(readTimeoutMs);
      const projection = await client.assistant(undefined, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (signal?.aborted) break;
      if (projection.assistant.coordinatorMemberId !== memberId) {
        status("not_configured");
      } else {
        const run = projection.runs.filter(item => item.coordinatorMemberId === memberId
          && item.status === "queued" && !item.attemptId && !item.sourceDeleted)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
        if (run) {
          // Selection is not acceptance. Only the runner's server claim can
          // establish that, so do not publish a pretend working notification.
          status("dispatching");
          await execute(run.id, { signal });
          continue;
        }
        status("waiting");
      }
      await delay(pollMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
}
