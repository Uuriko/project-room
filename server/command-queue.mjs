// #1905: async command pipeline (first slice: group commit).
//
// POST /commands fans in from many concurrent writers, but the store's
// write path is synchronous (better-sqlite3) with one WAL fsync per
// command, so throughput collapses to 1/latency under concurrency. This
// queue sits in front of the route: each request enqueues its command and
// awaits its own promise, while a per-room pump drains pending commands
// through store.commandBatch() — one sqlite transaction per batch, one
// fsync per batch, per-command savepoints preserving per-command
// atomicity and error shapes.
//
// Batching emerges under contention with no added latency at idle: the
// pump takes whatever is pending right now, and while it runs a batch
// (blocking the event loop) newly arrived requests accumulate into the
// next batch. A setImmediate between batches keeps streams/health
// responsive behind a long burst.
//
// Ordering: strictly FIFO per room, so sequence numbers stay contiguous
// and causation/idempotency behave exactly as with synchronous commands.
// Backpressure: maxDepth pending commands per room; beyond that the route
// fails fast with 503 command_queue_full instead of growing unbounded.
import { ServiceError } from "./service-error.mjs";

export function createCommandQueue({ store, maxBatch = 32, maxDepth = 2000 } = {}) {
  if (!store || typeof store.commandBatch !== "function") {
    throw new Error("createCommandQueue needs a store with commandBatch()");
  }
  const rooms = new Map(); // roomId -> { pending: [], pumping: boolean }

  function enqueue(roomId, item) {
    let q = rooms.get(roomId);
    if (!q) {
      q = { pending: [], pumping: false };
      rooms.set(roomId, q);
    }
    if (q.pending.length >= maxDepth) {
      throw new ServiceError(503, "command_queue_full",
        "The server is processing a burst of writes; retry shortly");
    }
    return new Promise((resolve, reject) => {
      q.pending.push({ item, resolve, reject });
      if (!q.pumping) {
        q.pumping = true;
        void pump(roomId, q);
      }
    });
  }

  async function pump(roomId, q) {
    while (true) {
      const batch = q.pending.splice(0, maxBatch);
      if (batch.length === 0) break;
      let results;
      try {
        results = store.commandBatch(roomId, batch.map(entry => entry.item));
      } catch (error) {
        // Catastrophic batch failure (the transaction itself rolled back):
        // nothing persisted, so every queued command fails with it.
        for (const entry of batch) entry.reject(error);
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        const outcome = results[i];
        if (outcome.ok) batch[i].resolve(outcome.result);
        else batch[i].reject(outcome.error);
      }
      // Let I/O breathe between batches; also lets the next batch accumulate.
      await new Promise(resolve => setImmediate(resolve));
    }
    // No await between the loop exit and this flag flip, so an enqueue that
    // lands here cannot slip past the recheck below.
    q.pumping = false;
    if (q.pending.length > 0) {
      q.pumping = true;
      void pump(roomId, q);
    } else if (rooms.get(roomId) === q) {
      rooms.delete(roomId);
    }
  }

  return { enqueue, _queueForTests: rooms };
}
