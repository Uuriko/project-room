// Wake-queue capacity and timing limits. Leaf module: the enforcing
// constants live here so light consumers (discovery, governance) can import
// them without pulling in server/store.mjs (node:sqlite). server/wake-queue.mjs
// re-exports this object; the values below are the single source of truth the
// WakeQueue class enforces.
export const wakeQueueLimits = Object.freeze({
  active: 200, receipts: 5000, horizon: 365 * 86400000,
  maxAttempts: 5, baseBackoffMs: 60000, maxBackoffMs: 3600000, leaseMs: 30000, intentBytes: 4096
});
