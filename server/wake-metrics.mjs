// Wake-reliability accounting (#3345; redesign charter B-5, step 1).
//
// Before this module the wake fabric had no countable delivery signal: a
// wake that never reached its agent looked exactly like an agent ignoring
// it. The fabric's stores already journal their own state (signals carry
// delivered_at, work wakes carry invalidated_at, the intent queue carries
// attempts/last_error) — what was missing is the audited outcome of every
// emission ATTEMPT and a journal of the loss classes, so emitted vs
// delivered vs acked can be reconciled per store, per door, per kind.
//
// Denominator (defined from the emission call sites, not from vibes):
// an attempt is one call intending to wake one agent about one event —
// wakeIfOffline (mention/DM fan-out), enqueueWake (bond, land,
// assignment, claim and direct callers), or a WorkWakes transition. Every
// attempt resolves to exactly one counted outcome:
//   emitted                 a new durable signal row exists
//   coalesced               an existing row absorbed the attempt (by design)
//   suppressed_no_host      wakeIfOffline gate: the identity has never
//                           registered a host (documented contract)
//   suppressed_no_identity  the target member has no identity link, so no
//                           identity-scoped door can ever address them —
//                           a LOSS class (journaled): before #3266 the
//                           claim path silently enqueued these under the
//                           bare memberId, creating undrainable stock
//   suppressed_policy       pause / readonly tier / trust / mute / opt-out
//                           gates refused the wake (by design)
//   failed                  the emission threw on a path that swallows
//                           (journaled) — the attempt was owed and lost
// Delivery is a signal's inclusion in a page/batch served on a door
// (heartbeat, poll, mcp, listener); ack is delivered_at set through an
// ack door (rest, mcp). Push is a doorbell, not delivery: its
// outcomes are counted separately (doorbell_delivered / doorbell_failed,
// failures journaled) and never enter the delivery rate.
//
// failureRate = (failed + suppressed_no_identity)
//             / (emitted + coalesced + failed + suppressed_no_identity)
// Designed suppressions (no_host, policy) are excluded from both sides:
// they are the fabric keeping its documented contract, reported in full
// in the outcome table so the rate can be re-derived either way.
//
// Privacy (#3345): counters and the journal carry kind + timestamp +
// subject id only — never message content, never exception text. Journal
// reasons come from the frozen allowlist below, not from error objects.
// Both tables are lazy/additive (created on first record, like the
// listener-lease tables) and registered in writer-fence lazyAdditiveTables.

export const WAKE_STORES = Object.freeze(["signals", "work", "queue"]);
export const WAKE_EVENTS = Object.freeze([
  "emitted", "coalesced", "suppressed_no_host", "suppressed_no_identity",
  "suppressed_policy", "failed", "delivered", "acked", "invalidated",
  "doorbell_delivered", "doorbell_failed", "ack_unregistered",
]);
export const WAKE_FAILURE_REASONS = Object.freeze([
  "no_identity_link", "enqueue_error", "push_delivery_failed",
]);
// A pending signal older than the 24h wakeability window whose agent has
// never polled is reported as aged stock, not silently young forever.
export const WAKE_STOCK_STALE_MS = 24 * 60 * 60 * 1000;
const FAILURE_JOURNAL_CAP = 1000;

export const wakeMetricsSchema = `
  CREATE TABLE IF NOT EXISTS agent_wake_counters (
    room_id TEXT NOT NULL DEFAULT '', store TEXT NOT NULL, event TEXT NOT NULL,
    door TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
    n INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, store, event, door, kind)
  );
  CREATE TABLE IF NOT EXISTS agent_wake_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL, room_id TEXT, store TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '', subject_id TEXT, reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_wake_failures_room ON agent_wake_failures(room_id, at);
`;

const ensured = new WeakSet();
export function ensureWakeMetricsSchema(db) {
  if (!db || ensured.has(db)) return false;
  db.exec(wakeMetricsSchema);
  ensured.add(db);
  return true;
}

const isMissingTable = error => /no such (table|column)/i.test(String(error?.message ?? ""));

// Record one audited wake outcome. Never throws: accounting rides the
// wake path and must not be able to fail a message post, a heartbeat or
// an ack. (Tests pin that counters DO move on every real path, so a
// silent no-op here cannot hide.) Returns true when recorded.
export function recordWakeEvent(db, { at, roomId = null, store, event, door = "", kind = "", n = 1, subjectId = null, reason = null } = {}) {
  try {
    if (!WAKE_STORES.includes(store) || !WAKE_EVENTS.includes(event)) return false;
    if (reason !== null && !WAKE_FAILURE_REASONS.includes(reason)) return false;
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    ensureWakeMetricsSchema(db);
    const stamp = Number.isSafeInteger(at) ? at : 0;
    db.prepare(`INSERT INTO agent_wake_counters (room_id, store, event, door, kind, n, first_at, last_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, store, event, door, kind) DO UPDATE SET
        n = n + excluded.n, last_at = excluded.last_at`)
      .run(roomId ?? "", store, event, door ?? "", kind ?? "", n, stamp, stamp);
    if (reason !== null) {
      db.prepare("INSERT INTO agent_wake_failures (at, room_id, store, kind, subject_id, reason) VALUES (?, ?, ?, ?, ?, ?)")
        .run(stamp, roomId ?? null, store, kind ?? "", subjectId ?? null, reason);
      db.prepare(`DELETE FROM agent_wake_failures WHERE id <=
        (SELECT MAX(id) FROM agent_wake_failures) - ?`).run(FAILURE_JOURNAL_CAP);
    }
    return true;
  } catch {
    return false;
  }
}

const emptyCounters = () => ({ emitted: 0, coalesced: 0, suppressed_no_host: 0,
  suppressed_no_identity: 0, suppressed_policy: 0, failed: 0, invalidated: 0,
  doorbell_delivered: 0, doorbell_failed: 0, ack_unregistered: 0,
  deliveredByDoor: {}, ackedByDoor: {} });

// Aggregate the counters + the stores' own stock into the accounting
// view. One bounded read per table; safe on pre-metrics databases (every
// section degrades to zeros/nulls, never an error), so the cockpit
// exceptions feed and operator surfaces can render it unconditionally.
export function wakeAccounting(db, { now = 0, roomId = null } = {}) {
  const byStore = { signals: emptyCounters(), work: emptyCounters(), queue: emptyCounters() };
  const failures = { total: 0, byReason: {}, recent: [] };
  const stock = { signalsPending: null, signalsAcked: null, signalsPendingUnreachable: null,
    signalsPendingAged: null, workPending: null, workAcked: null, workInvalidated: null,
    workPendingAged: null, queueByState: null, activityFanoutUnrecovered: null };
  const roomFilter = roomId === null ? null : roomId;
  try {
    ensureWakeMetricsSchema(db);
    const rows = roomFilter === null
      ? db.prepare("SELECT store, event, door, kind, n FROM agent_wake_counters").all()
      : db.prepare("SELECT store, event, door, kind, n FROM agent_wake_counters WHERE room_id=?").all(roomFilter);
    for (const row of rows) {
      const bucket = byStore[row.store];
      if (!bucket) continue;
      if (row.event === "delivered") bucket.deliveredByDoor[row.door] = (bucket.deliveredByDoor[row.door] ?? 0) + row.n;
      else if (row.event === "acked") bucket.ackedByDoor[row.door] = (bucket.ackedByDoor[row.door] ?? 0) + row.n;
      else if (Object.hasOwn(bucket, row.event)) bucket[row.event] += row.n;
    }
    const journal = roomFilter === null
      ? db.prepare("SELECT reason, COUNT(*) AS n FROM agent_wake_failures GROUP BY reason").all()
      : db.prepare("SELECT reason, COUNT(*) AS n FROM agent_wake_failures WHERE room_id=? GROUP BY reason").all(roomFilter);
    for (const row of journal) { failures.byReason[row.reason] = row.n; failures.total += row.n; }
    failures.recent = (roomFilter === null
      ? db.prepare("SELECT at, room_id AS roomId, store, kind, subject_id AS subjectId, reason FROM agent_wake_failures ORDER BY id DESC LIMIT 20").all()
      : db.prepare("SELECT at, room_id AS roomId, store, kind, subject_id AS subjectId, reason FROM agent_wake_failures WHERE room_id=? ORDER BY id DESC LIMIT 20").all(roomFilter))
      .map(row => Object.freeze(row));
  } catch (error) { if (!isMissingTable(error)) throw error; }
  const count = (sql, ...params) => {
    try { return db.prepare(sql).get(...params)?.n ?? 0; }
    catch (error) { if (!isMissingTable(error)) throw error; return null; }
  };
  const roomClause = roomFilter === null ? "" : " AND room_id=?";
  const roomParams = roomFilter === null ? [] : [roomFilter];
  stock.signalsPending = count(`SELECT COUNT(*) AS n FROM agent_wake_signals WHERE delivered_at IS NULL${roomClause}`, ...roomParams);
  stock.signalsAcked = count(`SELECT COUNT(*) AS n FROM agent_wake_signals WHERE delivered_at IS NOT NULL${roomClause}`, ...roomParams);
  stock.signalsPendingUnreachable = count(`SELECT COUNT(*) AS n FROM agent_wake_signals s WHERE s.delivered_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM agent_hosts h WHERE h.agent_id = s.agent_id)${roomFilter === null ? "" : " AND s.room_id=?"}`,
    ...roomParams);
  stock.signalsPendingAged = count(`SELECT COUNT(*) AS n FROM agent_wake_signals WHERE delivered_at IS NULL AND created_at <= ?${roomClause}`,
    now - WAKE_STOCK_STALE_MS, ...roomParams);
  stock.workPending = count(`SELECT COUNT(*) AS n FROM agent_work_wakes WHERE delivered_at IS NULL AND invalidated_at IS NULL${roomClause}`, ...roomParams);
  stock.workAcked = count(`SELECT COUNT(*) AS n FROM agent_work_wakes WHERE delivered_at IS NOT NULL${roomClause}`, ...roomParams);
  stock.workInvalidated = count(`SELECT COUNT(*) AS n FROM agent_work_wakes WHERE invalidated_at IS NOT NULL${roomClause}`, ...roomParams);
  stock.workPendingAged = count(`SELECT COUNT(*) AS n FROM agent_work_wakes WHERE delivered_at IS NULL AND invalidated_at IS NULL AND created_at <= ?${roomClause}`,
    now - WAKE_STOCK_STALE_MS, ...roomParams);
  try {
    const rows = db.prepare("SELECT state, COUNT(*) AS n FROM wake_queue GROUP BY state").all();
    stock.queueByState = Object.freeze(Object.fromEntries(rows.map(row => [row.state, row.n])));
  } catch (error) { if (!isMissingTable(error)) throw error; }
  stock.activityFanoutUnrecovered = count("SELECT COUNT(*) AS n FROM activity_fanout_failures WHERE recovered_at IS NULL");
  const s = byStore.signals, w = byStore.work;
  const lost = s.failed + s.suppressed_no_identity + w.failed + w.suppressed_no_identity;
  const owed = s.emitted + s.coalesced + s.failed + s.suppressed_no_identity
    + w.emitted + w.failed + w.suppressed_no_identity;
  return Object.freeze({
    asOf: now, roomId: roomFilter,
    byStore: Object.freeze(byStore),
    attempts: Object.freeze({
      emitted: s.emitted + w.emitted, coalesced: s.coalesced,
      suppressedNoHost: s.suppressed_no_host, suppressedNoIdentity: s.suppressed_no_identity + w.suppressed_no_identity,
      suppressedPolicy: s.suppressed_policy + w.suppressed_policy, failed: s.failed + w.failed,
    }),
    stock: Object.freeze(stock),
    failures: Object.freeze({ ...failures, byReason: Object.freeze(failures.byReason), recent: Object.freeze(failures.recent) }),
    loss: Object.freeze({ lostAttempts: lost, owedAttempts: owed,
      failureRate: owed > 0 ? lost / owed : 0 }),
  });
}
