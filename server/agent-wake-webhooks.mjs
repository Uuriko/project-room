// Counts-only agent.wake webhook support (hs2-webhook-counts, 1c).
//
// The agent.wake webhook names the agent and how many wake signals are
// pending — never the signal content — mirroring the human push channel's
// standing privacy contract (counts-only unless the receiver opts into
// more). The full signal payload remains available behind an explicit
// opt-in (buildWakePing full:true); the redelivery queue itself is the
// durable webhook delivery journal in server/agent-plugin-store.mjs
// (pending -> failed with backoff -> dead_letter, plus manual redrive),
// which already covers wake pings end to end.
//
// Pure helpers: no network I/O. pendingWakeCounts takes the shared db;
// a missing agent_wake_signals table (older DB) yields zeros, never a
// throw — a wake ping must never fail because the queue table is absent.
const check = (condition, message) => {
  if (!condition) throw new Error(`invalid_wake_counts: ${message}`);
};

const isCount = n => Number.isInteger(n) && n >= 0;

// Tally an in-memory signal list by kind. Unknown kinds still count
// toward pending — the receiver pulls the real queue on poll.
export function wakeCountsFromSignals(signals) {
  check(Array.isArray(signals), "signals must be an array");
  let mentions = 0, dms = 0;
  for (const signal of signals) {
    if (signal?.kind === "mention") mentions++;
    else if (signal?.kind === "dm") dms++;
  }
  return Object.freeze({ pending: signals.length, mentions, dms });
}

// Normalize caller-supplied counts (buildWakePing's `counts` argument).
// Missing or non-integer fields fail closed — a wake ping never ships a
// fabricated count.
export function normalizeWakeCounts(counts) {
  if (counts === null || counts === undefined) return Object.freeze({ pending: 0, mentions: 0, dms: 0 });
  check(counts !== null && typeof counts === "object" && !Array.isArray(counts), "counts must be an object");
  for (const field of ["pending", "mentions", "dms"]) {
    check(isCount(counts[field]), `counts.${field} must be a non-negative integer`);
  }
  check(counts.mentions + counts.dms <= counts.pending,
    "counts.mentions + counts.dms must not exceed counts.pending");
  return Object.freeze({ pending: counts.pending, mentions: counts.mentions, dms: counts.dms });
}

// Exact, uncapped tally of the durable mention/DM wake queue for one
// agent. Delivered (acknowledged) signals are excluded. Work-claim wakes
// ride their own queue and are not part of these counts; the receiver
// pulls the full pending set (including work wakes) via the wake poll.
export function pendingWakeCounts(db, agentId) {
  check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
  let rows;
  try {
    rows = db.prepare(
      `SELECT kind, COUNT(*) AS n FROM agent_wake_signals
       WHERE agent_id=? AND delivered_at IS NULL GROUP BY kind`).all(agentId);
  } catch {
    return Object.freeze({ pending: 0, mentions: 0, dms: 0 });
  }
  let mentions = 0, dms = 0, other = 0;
  for (const row of rows) {
    const n = Number(row?.n ?? 0);
    if (row?.kind === "mention") mentions += n;
    else if (row?.kind === "dm") dms += n;
    else other += n;
  }
  return Object.freeze({ pending: mentions + dms + other, mentions, dms });
}
