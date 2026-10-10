import { EVENT_TYPES, validId } from "../src/events.js";

const types = new Set(Object.values(EVENT_TYPES));
export const MAX_BATCH_COMMANDS = 100;

// One host/tool invocation, bounded parallel HTTP calls. Not a transaction:
// only batch independent commands. The ordinary server checks still apply.
export function validateBatch(commands, concurrency = 4) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Concurrency must be an integer from 1 to 8");
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_BATCH_COMMANDS)
    throw new Error("Supply 1 to 100 commands");
  const ids = new Set();
  for (const command of commands) {
    if (!command || Array.isArray(command) || !validId(command.id) || ids.has(command.id)
      || !types.has(command.type) || !command.data || typeof command.data !== "object" || Array.isArray(command.data)
      || Object.keys(command).some(key => !["id", "type", "data"].includes(key)))
      throw new Error("Each command needs a unique stable id, known type and data object");
    ids.add(command.id);
  }
}

export async function runAgentBatch(client, commands, { concurrency = 4, signal } = {}) {
  validateBatch(commands, concurrency);
  if (typeof client?.command !== "function") throw new Error("A room command client is required");
  // Freeze the submission bytes before starting any request. Retry/reconcile
  // with these same IDs and payloads, never freshly generated replacements.
  const pending = JSON.parse(JSON.stringify(commands));
  const results = pending.map(command => ({ id: command.id, status: "not_sent" }));
  let next = 0, stopped = false;
  async function worker() {
    while (!stopped && !signal?.aborted && next < pending.length) {
      const index = next++, command = pending[index];
      try {
        const result = await client.command(command, { signal });
        if (!Number.isSafeInteger(result?.sequence) || result.sequence < 1 || typeof result?.duplicate !== "boolean")
          throw Object.assign(new Error("Unconfirmed command receipt"), { code: "invalid_response", status: 200 });
        results[index] = { id: command.id, status: "accepted", result };
      } catch (error) {
        const httpStatus = Number.isInteger(error?.status) ? error.status : null;
        const rejected = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;
        results[index] = { id: command.id, status: rejected ? "rejected" : "unknown",
          code: typeof error?.code === "string" ? error.code : "request_unconfirmed", httpStatus,
          ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) };
        // Don't amplify throttling or invalid credentials. Already-started
        // requests still settle individually; queued requests remain not_sent.
        if ([401, 403, 429].includes(httpStatus) || !rejected) stopped = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { results, counts: Object.fromEntries(["accepted", "rejected", "unknown", "not_sent"]
    .map(status => [status, results.filter(result => result.status === status).length])) };
}
