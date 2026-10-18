// Stored performance aggregates (#3618, accountability R-12).
//
// The aggregates a buyer, insurer, or performance warranty actually asks
// for — "what is this agent's acceptance rate / reversal rate / dispute
// rate / incident count over 90 days?" — were not maintained anywhere.
// What existed was a reputation ELIGIBILITY score (server/reputation.mjs):
// a derived, decayed, bounded standing artifact that cannot answer a
// rate question, and that is replay-derived on every read, never stored.
//
// This module maintains those rates as FIRST-CLASS STORED RECORDS:
// one record per (subject, window), carrying the raw counts, the rates,
// an incident count, the window bounds, and an as-of timestamp. A reader
// gets the record as stored — rates are never recomputed per read.
//
// Raw signals come from the EXISTING projector folds, not a new stream:
//   - the bounty adapter reuses signalsForEvent (server/bounty-reputation.mjs)
//     — dispute_won / dispute_lost, acceptance_overturned, claim_judged_bad's
//     bounty analogue, claim_flaked, bond_forfeited are already folded there —
//     and adds only the two rules signalsForEvent intentionally does not
//     emit as reputation types: bounty.rejected as a `rejected` outcome for
//     the claimant, and an upheld bounty.decided as a `reversed` outcome
//     for the claimant (their accepted work was overturned).
//   - the claim adapter reuses deriveClaimSignals (server/claim-reputation.mjs)
//     — claim_completed / claim_flaked / claim_judged_bad / claim_released.
//
// Rate definitions (denominators are part of the record's meaning; every
// rate is null when its denominator is 0, never a fabricated 0):
//   acceptanceRate = accepted / (accepted + rejected)
//   reversalRate   = reversed / accepted
//     (reversed counts CLAIMANT-side overturns only; a verifier's overturned
//      acceptances are kept as the raw acceptancesOverturned count — the
//      verifier track record — and are not mixed into this numerator,
//      whose denominator is the subject's own accepted work)
//   disputeRate    = disputed / outcomeTotal
//     outcomeTotal = accepted + rejected + paid + completed + flaked
//                    + judgedBad + disputed
//     (disputeWon/disputeLost/disputeSplit are facets of a disputed
//      outcome, not extra outcomes, so they never double-count here)
//
// Windows are named rolling windows ending at the record's asOfMs:
// 7d / 30d / 90d are (asOfMs - window, asOfMs]; all is (-inf, asOfMs].
//
// Subjects are agents and rooms. Room counts are involvement sums over
// the room's agent observations: a decided dispute contributes one
// disputed involvement per party, so room dispute counts count
// involvements, not dispute events.
//
// Incident count comes from R-10 linkage (server/records-incidents.mjs):
// incidentCountsBySubject() yields distinct-incident counts keyed
// `agent:<id>` / `room:<id>`; refresh injects them, the pure compute path
// takes them as an argument. An aggregate computed without linkage
// carries incidentCount 0 — linkage is additive, never guessed.
//
// Refresh: EXPLICIT RECOMPUTE, deliberately not a jobs.mjs cadence hook.
// The existing projectors are pure folds with no scheduler owner, and
// claim-reputation's standing pattern is projector + sync script
// (scripts/claim-reputation-sync.mjs). This module follows it:
// refreshPerformanceAggregates() folds the supplied event streams and
// upserts the stored records, and scripts/records-aggregates-sync.mjs is
// the operator entry point. Records are keyed by the deterministic id
// agg_<subjectKind>_<subjectId>_<window>, so a re-refresh replaces the
// record for its as-of and can never double-count. Live wiring into a
// cadence, if wanted, is a later analytics-lane decision.
import { signalsForEvent } from "./bounty-reputation.mjs";
import { deriveClaimSignals } from "./claim-reputation.mjs";
import { incidentCountsBySubject, listIncidentLinks } from "./records-incidents.mjs";

export class PerformanceAggregateError extends Error {
  constructor(code, message) { super(message); this.name = "PerformanceAggregateError"; this.code = code; }
}
const fail = (code, message) => { throw new PerformanceAggregateError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_performance_aggregate", message); };

const DAY_MS = 24 * 3600 * 1000;
export const AGGREGATE_WINDOWS = Object.freeze({
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
  "all": null,
});
export const AGGREGATE_WINDOW_NAMES = Object.freeze(Object.keys(AGGREGATE_WINDOWS));
export const AGGREGATE_SUBJECT_KINDS = Object.freeze(["agent", "room"]);

// The canonical outcome/count vocabulary of an aggregate record. Every
// record carries every key (0 when unseen) so consumers never guess at
// a missing field's meaning.
export const AGGREGATE_COUNT_KEYS = Object.freeze([
  "accepted", "rejected", "paid", "completed", "released", "flaked",
  "judgedBad", "bondForfeited", "disputed", "disputeWon", "disputeLost",
  "disputeSplit", "reversed", "acceptancesOverturned",
]);

const emptyCounts = () => Object.fromEntries(AGGREGATE_COUNT_KEYS.map(key => [key, 0]));

const laneOf = value => (typeof value === "string" && value.length > 0 ? value : null);
const msOf = value => {
  if (Number.isInteger(value) && value >= 0) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

// --- observations: the adapters over the existing projector folds -------------

// One observation = one counted outcome for one agent in one room at a
// time. computeAggregates() folds observations; nothing else in this
// module knows where an observation came from.
function observation(agentId, roomId, atMs, kind) {
  return Object.freeze({ agentId, roomId, atMs, kind });
}

// Bounty events in listEvents() shape ({ type, data, at, seq }) for ONE
// room (the projector's calling convention: roomId is the caller's).
export function observationsFromBountyEvents(events, { roomId = null } = {}) {
  check(Array.isArray(events), "events must be an array");
  const out = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const atMs = msOf(event.at);
    if (atMs === null) continue;
    const data = event.data ?? {};
    // Reuse the reputation fold for every signal it already types.
    for (const signal of signalsForEvent(event)) {
      const agent = laneOf(signal.agent);
      if (!agent) continue;
      switch (signal.type) {
        case "submission_accepted": out.push(observation(agent, roomId, atMs, "accepted")); break;
        case "payout_released": out.push(observation(agent, roomId, atMs, "paid")); break;
        case "dispute_won":
          out.push(observation(agent, roomId, atMs, "disputed"), observation(agent, roomId, atMs, "disputeWon"));
          break;
        case "dispute_lost":
          out.push(observation(agent, roomId, atMs, "disputed"), observation(agent, roomId, atMs, "disputeLost"));
          break;
        case "dispute_split":
          out.push(observation(agent, roomId, atMs, "disputed"), observation(agent, roomId, atMs, "disputeSplit"));
          break;
        case "acceptance_overturned": out.push(observation(agent, roomId, atMs, "acceptancesOverturned")); break;
        case "bond_forfeited": out.push(observation(agent, roomId, atMs, "bondForfeited")); break;
        case "claim_flaked": out.push(observation(agent, roomId, atMs, "flaked")); break;
        default: break; // sybil_confirmed etc.: reputation-only, not a rate outcome
      }
    }
    // The two rules the reputation vocabulary deliberately lacks.
    if (event.type === "bounty.rejected") {
      const claimant = laneOf(data.claimant);
      if (claimant) out.push(observation(claimant, roomId, atMs, "rejected"));
    }
    if (event.type === "bounty.decided" && data.outcome === "upheld") {
      // The claimant's accepted work was overturned: their one reversal.
      // (dispute_lost + bond_forfeited for the same event already arrived
      // via signalsForEvent above; the verifier's overturn arrives there
      // as acceptancesOverturned.)
      const claimant = laneOf(data.claimant);
      if (claimant) out.push(observation(claimant, roomId, atMs, "reversed"));
    }
  }
  return Object.freeze(out);
}

// work_claim.updated rows in deriveClaimSignals() shape
// ({ roomId, seq, atMs, data }).
export function observationsFromClaimRows(rows) {
  check(Array.isArray(rows), "rows must be an array");
  // Fold each room on its own, exactly like syncClaimReputationJournal:
  // claim state is keyed by (roomId, claimId), so rooms never share a
  // position — and the signal keeps the room it was folded in.
  const byRoom = new Map();
  for (const row of rows) {
    const roomId = row?.roomId ?? null;
    if (!byRoom.has(roomId)) byRoom.set(roomId, []);
    byRoom.get(roomId).push(row);
  }
  const out = [];
  for (const [roomId, roomRows] of byRoom) {
    for (const signal of deriveClaimSignals(roomRows)) {
      const kind = {
        claim_completed: "completed",
        claim_released: "released",
        claim_flaked: "flaked",
        claim_judged_bad: "judgedBad",
      }[signal.type];
      if (!kind) continue; // claim_hoarded: a surcharge signal, not an outcome rate input
      out.push(observation(signal.agent, roomId, signal.at, kind));
    }
  }
  return Object.freeze(out);
}

// --- the pure fold --------------------------------------------------------------

const rate = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

export function ratesForCounts(counts) {
  const outcomeTotal = counts.accepted + counts.rejected + counts.paid + counts.completed
    + counts.flaked + counts.judgedBad + counts.disputed;
  return Object.freeze({
    acceptanceRate: rate(counts.accepted, counts.accepted + counts.rejected),
    reversalRate: rate(counts.reversed, counts.accepted),
    disputeRate: rate(counts.disputed, outcomeTotal),
    outcomeTotal,
  });
}

const aggregateId = (subjectKind, subjectId, window) => `agg_${subjectKind}_${subjectId}_${window}`;

function buildRecord({ subjectKind, subjectId, window, asOfMs, counts, incidentCount }) {
  const duration = AGGREGATE_WINDOWS[window];
  const { outcomeTotal, ...rates } = ratesForCounts(counts);
  return Object.freeze({
    id: aggregateId(subjectKind, subjectId, window),
    subjectKind,
    subjectId,
    window,
    windowStartMs: duration === null ? null : asOfMs - duration,
    asOfMs,
    counts: Object.freeze({ ...counts }),
    outcomeTotal,
    rates: Object.freeze(rates),
    incidentCount,
    source: "bounty+claim-projector-folds",
  });
}

// Fold observations into aggregate records for every observed subject
// (agents, and rooms when observations carry a roomId), for every named
// window. incidentCounts is a Map keyed `agent:<id>` / `room:<id>` as
// produced by incidentCountsBySubject() (records-incidents.mjs).
export function computeAggregates(observations, { asOfMs, windows = AGGREGATE_WINDOW_NAMES, incidentCounts = new Map() } = {}) {
  check(Array.isArray(observations), "observations must be an array");
  check(Number.isInteger(asOfMs) && asOfMs >= 0, "asOfMs must be a non-negative integer ms timestamp");
  check(Array.isArray(windows) && windows.length >= 1 && windows.every(name => name in AGGREGATE_WINDOWS),
    `windows must name one or more of ${AGGREGATE_WINDOW_NAMES.join(", ")}`);
  check(incidentCounts instanceof Map, "incidentCounts must be a Map");
  const records = [];
  for (const window of windows) {
    const duration = AGGREGATE_WINDOWS[window];
    const windowStartMs = duration === null ? null : asOfMs - duration;
    const perSubject = new Map(); // key -> { subjectKind, subjectId, counts }
    const bucket = (subjectKind, subjectId) => {
      const key = `${subjectKind}\n${subjectId}`;
      if (!perSubject.has(key)) perSubject.set(key, { subjectKind, subjectId, counts: emptyCounts() });
      return perSubject.get(key);
    };
    for (const entry of observations) {
      if (!entry || typeof entry !== "object") continue;
      const agent = laneOf(entry.agentId);
      const atMs = msOf(entry.atMs);
      if (!agent || atMs === null || !AGGREGATE_COUNT_KEYS.includes(entry.kind)) continue;
      if (atMs > asOfMs) continue; // the future is not in any window ending at asOf
      if (windowStartMs !== null && atMs <= windowStartMs) continue; // rolling window is (start, asOf]
      bucket("agent", agent).counts[entry.kind] += 1;
      const room = laneOf(entry.roomId);
      if (room) bucket("room", room).counts[entry.kind] += 1;
    }
    for (const { subjectKind, subjectId, counts } of perSubject.values()) {
      records.push(buildRecord({
        subjectKind, subjectId, window, asOfMs, counts,
        incidentCount: incidentCounts.get(`${subjectKind}:${subjectId}`) ?? 0,
      }));
    }
  }
  records.sort((a, b) => a.subjectKind.localeCompare(b.subjectKind)
    || a.subjectId.localeCompare(b.subjectId) || a.window.localeCompare(b.window));
  return Object.freeze(records);
}

// Validate/normalize an aggregate as stored. Round-trips buildRecord()
// output exactly; a record whose rates do not match its counts fails
// closed — a stored rate that disagrees with its own counts is exactly
// the evidence failure this module exists to prevent.
export function aggregateOf(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "aggregate must be an object");
  check(AGGREGATE_SUBJECT_KINDS.includes(value.subjectKind), "subjectKind must be agent or room");
  check(typeof value.subjectId === "string" && value.subjectId.length > 0, "subjectId is required");
  check(value.window in AGGREGATE_WINDOWS, `window must be one of ${AGGREGATE_WINDOW_NAMES.join(", ")}`);
  check(Number.isInteger(value.asOfMs) && value.asOfMs >= 0, "asOfMs must be a non-negative integer ms timestamp");
  check(value.counts && typeof value.counts === "object", "counts are required");
  const counts = emptyCounts();
  for (const key of AGGREGATE_COUNT_KEYS) {
    check(Number.isInteger(value.counts[key]) && value.counts[key] >= 0, `counts.${key} must be a non-negative integer`);
    counts[key] = value.counts[key];
  }
  check(Number.isInteger(value.incidentCount) && value.incidentCount >= 0, "incidentCount must be a non-negative integer");
  const rebuilt = buildRecord({
    subjectKind: value.subjectKind, subjectId: value.subjectId, window: value.window,
    asOfMs: value.asOfMs, counts, incidentCount: value.incidentCount,
  });
  check(value.id === rebuilt.id, "aggregate id does not match its subject/window");
  check(value.outcomeTotal === rebuilt.outcomeTotal, "stored outcomeTotal does not match its counts");
  for (const key of ["acceptanceRate", "reversalRate", "disputeRate"]) {
    const stored = value.rates?.[key] ?? null;
    check(stored === rebuilt.rates[key], `stored rates.${key} does not match its counts`);
  }
  return rebuilt;
}

// --- SQLite stored records ------------------------------------------------------

export const PERFORMANCE_AGGREGATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS performance_aggregate_records (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  window_name TEXT NOT NULL,
  as_of_ms INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS performance_aggregate_records_subject
  ON performance_aggregate_records(subject_kind, subject_id);
`;

export function ensurePerformanceAggregatesSchema(db) {
  db.exec(PERFORMANCE_AGGREGATES_SCHEMA);
}

export function storeAggregates(db, records) {
  ensurePerformanceAggregatesSchema(db);
  const upsert = db.prepare(`INSERT INTO performance_aggregate_records
    (id, subject_kind, subject_id, window_name, as_of_ms, body) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET as_of_ms=excluded.as_of_ms, body=excluded.body`);
  let written = 0;
  const writeOne = raw => {
    const record = aggregateOf(raw);
    written += upsert.run(record.id, record.subjectKind, record.subjectId,
      record.window, record.asOfMs, JSON.stringify(record)).changes;
  };
  const write = db.transaction
    ? db.transaction(list => { for (const record of list) writeOne(record); })
    : (list => { for (const record of list) writeOne(record); });
  write(records);
  return { aggregatesWritten: written };
}

export function getAggregate(db, subjectKind, subjectId, window) {
  ensurePerformanceAggregatesSchema(db);
  const row = db.prepare("SELECT body FROM performance_aggregate_records WHERE id=?")
    .get(aggregateId(subjectKind, subjectId, window));
  return row ? aggregateOf(JSON.parse(row.body)) : null;
}

export function listAggregates(db, { subjectKind = null, subjectId = null } = {}) {
  ensurePerformanceAggregatesSchema(db);
  const rows = subjectKind && subjectId
    ? db.prepare("SELECT body FROM performance_aggregate_records WHERE subject_kind=? AND subject_id=? ORDER BY window_name").all(subjectKind, subjectId)
    : db.prepare("SELECT body FROM performance_aggregate_records ORDER BY subject_kind, subject_id, window_name").all();
  return Object.freeze(rows.map(row => aggregateOf(JSON.parse(row.body))));
}

// --- explicit recompute (the refresh path) --------------------------------------

// Fold the supplied streams, inject R-10 incident counts, and upsert the
// stored records. `bountyEventsByRoom` is a Map(roomId -> listEvents()
// rows) or a plain object; `recordsById` maps incident-linked recordIds
// to the records themselves (for incidentCountsBySubject). Re-running
// with the same inputs and asOfMs replaces identical records — the fold
// can never double-count.
export function refreshPerformanceAggregates(db, {
  bountyEventsByRoom = new Map(),
  claimRows = [],
  recordsById = new Map(),
  asOfMs,
  windows = AGGREGATE_WINDOW_NAMES,
} = {}) {
  check(db && typeof db.prepare === "function", "a database handle is required");
  check(Number.isInteger(asOfMs) && asOfMs >= 0, "asOfMs must be a non-negative integer ms timestamp");
  const observations = [];
  const roomEntries = bountyEventsByRoom instanceof Map
    ? [...bountyEventsByRoom.entries()] : Object.entries(bountyEventsByRoom ?? {});
  for (const [roomId, events] of roomEntries) {
    observations.push(...observationsFromBountyEvents(events, { roomId }));
  }
  observations.push(...observationsFromClaimRows(claimRows));
  const links = listIncidentLinks(db, null);
  const incidentCounts = incidentCountsBySubject([...links], recordsById);
  const records = computeAggregates(observations, { asOfMs, windows, incidentCounts });
  const { aggregatesWritten } = storeAggregates(db, records);
  return Object.freeze({
    observations: observations.length,
    incidentsLinked: links.length,
    aggregatesWritten,
    aggregates: records,
    asOfMs,
  });
}
