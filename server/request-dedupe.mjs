// STUB — crash-recovery guild system #1 (request ids on mutating routes).
//
// TEMPORARY in-memory fake of the request-dedupe contract that guild worker
// B1 is building at this same path (server/request-dedupe.mjs). It exists so
// B2's routes and tests can land against the agreed API before B1's real,
// DB-backed module is merged.
//
// B5: DELETE THIS FILE when B1's real module lands here, and wire the real
// store in server init as `store.requestDedupe = createDedupeStore(store.db)`.
// The routes import only `readRequestId` from this path and read the store
// via `store?.requestDedupe` with a null-guard, so no route changes are
// needed when you swap this out.
//
// Contract:
//   readRequestId(data) -> id | null   // body.requestId, string 1..128, never throws
//   createDedupeStore(db, { ttlMs })   // { check, record, prune }
export function readRequestId(data) {
  try {
    const id = data?.requestId;
    return typeof id === "string" && id.length >= 1 && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

export function createDedupeStore(db, { ttlMs = 86400000 } = {}) {
  // db is unused in the stub: the real store persists entries here so a
  // restart does not forget in-flight request ids.
  void db;
  const seen = new Map(); // requestId -> { at: ms, result }
  return {
    check(requestId) {
      const entry = seen.get(requestId);
      if (entry === undefined) return { duplicate: false };
      if (Date.now() - entry.at > ttlMs) { seen.delete(requestId); return { duplicate: false }; }
      return { duplicate: true, result: entry.result };
    },
    record(requestId, result) { seen.set(requestId, { at: Date.now(), result }); },
    prune(nowMs) { for (const [key, entry] of seen) if (nowMs - entry.at > ttlMs) seen.delete(key); },
  };
}
