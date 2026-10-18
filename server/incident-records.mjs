// Incident linkage + performance aggregate records (accountability
// R-10/R-12, issue #3618).
//
// Two record families the accountability gaps named, built at the
// record/API level only — no incident-management UI, no alerting pipeline:
//
// (1) INCIDENT RECORDS. An incident is a first-class stored record (id,
// room, scope, opened/closed lifecycle) carrying selectors over exactly
// four dimensions: credential, version, room, subject. A selector matches
// a run record when every dimension it names matches (AND semantics).
// linkIncident() materializes the link from affected records to the
// incident (incident_record_links rows + incidentsForRecord() reads the
// link back from a record's side), and enumerateBySelectors() /
// enumerateIncident() are the one-query enumeration reads — the
// incident-notification query: after an incident, one call returns every
// run touched by its selectors.
//
// Run records are the durable event records that already exist:
// bounty_events rows (escrow) and room-store `events` rows, normalized to
// { kind, id, roomId, seq, at, type, subject, credential, version } where
// subject is the bountyId / workClaim id, credential is the acting lane
// (bounty actor_id, or the event data's ownerId/actor/claimant/earner),
// and version is the version stamped on the record today
// (data.rubricVersion / data.termsVersion / data.rubric_version).
//
// (2) PERFORMANCE AGGREGATE RECORDS. Rolling per-agent and per-room
// aggregates over named windows (AGGREGATE_WINDOWS: 7d / 30d / 90d),
// stored as first-class records carrying their window, window bounds,
// as-of timestamp, and the fold input counts, so any reader can recompute
// the rates from the inputs. The counts come FROM the existing reputation
// projector folds — bounty-reputation's signalsForEvent() and
// claim-reputation's deriveClaimSignals() — never a second counting
// implementation. The eligibility score in reputation.mjs is a different
// artifact and is untouched.
//
// Rate definitions (all inputs are projector signal counts for the
// subject over the window):
//   judgedSubmissions = submissionAccepted + submissionsRejected + claimJudgedBad
//     (submissionsRejected = the bond_forfeited signals the bounty
//     projector emits for bounty.rejected events)
//   acceptanceRate = submissionAccepted / judgedSubmissions
//   disputeOutcomes  = disputeWon + disputeLost
//   disputeRate      = disputeOutcomes / (judgedSubmissions + disputeOutcomes)
//   reversalRate     = acceptanceOverturned / (submissionAccepted + acceptanceOverturned)
//     (acceptance_overturned lands on the verifier whose pinned-rubric
//     acceptance an upheld dispute overturned; the denominator is the
//     acceptance-side outcomes the fold attributes to the lane)
//   incidentCount    = distinct incidents opened in the window with at
//     least one linked record matching the subject (the agent's
//     credential, or the room)
// A rate is null when its denominator is zero — no history, no rate,
// never a fabricated 0.
//
// Storage is purely additive, like claim_reputation_signals and
// sla_breach_alerts: CREATE TABLE IF NOT EXISTS, created lazily on first
// use, registered in server/writer-fence.mjs (lazyAdditiveTables) so the
// recovery audit keeps passing on databases that never see these tables.
// No schema version bump, no writer-fence impact beyond that list.
import { randomUUID } from "node:crypto";
import { signalsForEvent } from "./bounty-reputation.mjs";
import { deriveClaimSignals } from "./claim-reputation.mjs";

class IncidentRecordError extends Error {
  constructor(code, message) { super(message); this.name = "IncidentRecordError"; this.code = code; }
}
const fail = (code, message) => { throw new IncidentRecordError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const INCIDENT_SELECTOR_DIMENSIONS = Object.freeze(["credential", "version", "room", "subject"]);
const DAY_MS = 24 * 3600 * 1000;
export const AGGREGATE_WINDOWS = Object.freeze({ "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, "90d": 90 * DAY_MS });
export const ACCOUNTABILITY_RECORD_TABLES = Object.freeze(["incidents", "incident_record_links", "performance_aggregates"]);

export const INCIDENT_RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','closed')),
  selectors TEXT NOT NULL CHECK(json_valid(selectors)),
  opened_by TEXT,
  opened_at INTEGER NOT NULL,
  closed_by TEXT,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_room ON incidents(room_id, opened_at);
CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, opened_at);
CREATE TABLE IF NOT EXISTS incident_record_links (
  incident_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  room_id TEXT,
  subject TEXT,
  credential TEXT,
  version TEXT,
  record_at INTEGER,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id, record_kind, record_id)
);
CREATE INDEX IF NOT EXISTS incident_record_links_record ON incident_record_links(record_kind, record_id);
CREATE INDEX IF NOT EXISTS incident_record_links_credential ON incident_record_links(credential);
CREATE TABLE IF NOT EXISTS performance_aggregates (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('agent','room')),
  subject_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  window_name TEXT NOT NULL,
  window_from_ms INTEGER NOT NULL,
  window_to_ms INTEGER NOT NULL,
  as_of_ms INTEGER NOT NULL,
  acceptance_rate REAL,
  reversal_rate REAL,
  dispute_rate REAL,
  incident_count INTEGER NOT NULL,
  inputs TEXT NOT NULL CHECK(json_valid(inputs))
);
CREATE INDEX IF NOT EXISTS performance_aggregates_subject
  ON performance_aggregates(subject_kind, subject_id, room_id, window_name, as_of_ms);
`;

export function ensureIncidentRecordsSchema(db) {
  db.exec(INCIDENT_RECORDS_SCHEMA);
}

const hasTable = (db, name) => Boolean(
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

const textOf = (value, field) => {
  check(typeof value === "string" && value.length > 0, "invalid_incident_record", `${field} must be a non-empty string`);
  return value;
};
const msOf = (value, field) => {
  check(Number.isInteger(value) && value >= 0, "invalid_incident_record", `${field} must be a non-negative integer ms timestamp`);
  return value;
};

// Normalize + validate a selector: an object naming at least one of the
// four filed dimensions, each a non-empty string (version is stringified
// so a selector written against a numeric rubric pin still matches the
// stamped value). Unknown dimensions are rejected — no scope creep into
// free-text search.
export function normalizeSelectors(selectors) {
  check(selectors && typeof selectors === "object" && !Array.isArray(selectors),
    "invalid_selector", "selectors must be an object over credential/version/room/subject");
  const out = {};
  for (const [key, value] of Object.entries(selectors)) {
    check(INCIDENT_SELECTOR_DIMENSIONS.includes(key), "invalid_selector", `unknown selector dimension "${key}"`);
    check(typeof value === "string" || (key === "version" && Number.isInteger(value)),
      "invalid_selector", `selector "${key}" must be a non-empty string`);
    const text = String(value);
    check(text.length > 0, "invalid_selector", `selector "${key}" must be a non-empty string`);
    out[key] = text;
  }
  check(Object.keys(out).length > 0, "invalid_selector", "a selector must name at least one dimension");
  return Object.freeze(out);
}

// --- incident records -------------------------------------------------------

const incidentView = row => Object.freeze({
  id: row.id, roomId: row.room_id, scope: row.scope, status: row.status,
  selectors: Object.freeze(JSON.parse(row.selectors)),
  openedBy: row.opened_by, openedAt: row.opened_at,
  closedBy: row.closed_by, closedAt: row.closed_at,
  createdAt: row.created_at, updatedAt: row.updated_at
});

// Open an incident record. Opening is an operator/owner act; this is the
// record, not a workflow. `at` is ms epoch (defaults to now).
export function openIncident(db, { id = null, roomId = null, scope, selectors, openedBy = null, at = null } = {}) {
  ensureIncidentRecordsSchema(db);
  textOf(scope, "scope");
  if (roomId !== null) textOf(roomId, "roomId");
  if (openedBy !== null) textOf(openedBy, "openedBy");
  const cleanSelectors = normalizeSelectors(selectors);
  const now = at === null ? Date.now() : msOf(at, "at");
  const incidentId = id === null ? `inc_${randomUUID()}` : textOf(id, "id");
  db.prepare(`INSERT INTO incidents
    (id, room_id, scope, status, selectors, opened_by, opened_at, closed_by, closed_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(incidentId, roomId, scope, "open", JSON.stringify(cleanSelectors), openedBy, now, null, null, now, now);
  return getIncident(db, incidentId);
}

export function getIncident(db, incidentId) {
  ensureIncidentRecordsSchema(db);
  const row = db.prepare("SELECT * FROM incidents WHERE id=?").get(incidentId);
  check(row, "unknown_incident", `no incident record "${incidentId}"`);
  return incidentView(row);
}

export function closeIncident(db, incidentId, { at = null, closedBy = null } = {}) {
  ensureIncidentRecordsSchema(db);
  const current = getIncident(db, incidentId);
  check(current.status === "open", "incident_not_open", `incident "${incidentId}" is already closed`);
  if (closedBy !== null) textOf(closedBy, "closedBy");
  const now = at === null ? Date.now() : msOf(at, "at");
  db.prepare("UPDATE incidents SET status='closed', closed_by=?, closed_at=?, updated_at=? WHERE id=?")
    .run(closedBy, now, now, incidentId);
  return getIncident(db, incidentId);
}

export function listIncidents(db, { roomId = null, status = null } = {}) {
  ensureIncidentRecordsSchema(db);
  const rows = db.prepare(`SELECT * FROM incidents
    WHERE (? IS NULL OR room_id=?) AND (? IS NULL OR status=?) ORDER BY opened_at, id`)
    .all(roomId, roomId, status, status);
  return Object.freeze(rows.map(incidentView));
}

// --- enumeration ------------------------------------------------------------

// SQL fragments matching one normalized selector against each durable
// record source. Version stamps are compared as text so numeric pins
// (rubricVersion: 2) and string pins ("2") are the same selector value.
const VERSION_PATHS_BOUNTY = ["$.rubricVersion", "$.termsVersion", "$.rubric_version"];
const VERSION_PATHS_EVENT = ["$.data.rubricVersion", "$.data.termsVersion", "$.data.rubric_version"];
const versionCond = (column, paths, params, value) => {
  const parts = paths.map(p => `CAST(json_extract(${column},'${p}') AS TEXT) = ?`);
  for (let i = 0; i < paths.length; i++) params.push(value);
  return `(${parts.join(" OR ")})`;
};

function bountyBranch(selectors, params) {
  const conds = [];
  if (selectors.room !== undefined) { conds.push("room_id = ?"); params.push(selectors.room); }
  if (selectors.subject !== undefined) { conds.push("bounty_id = ?"); params.push(selectors.subject); }
  if (selectors.credential !== undefined) { conds.push("actor_id = ?"); params.push(selectors.credential); }
  if (selectors.version !== undefined) conds.push(versionCond("data", VERSION_PATHS_BOUNTY, params, selectors.version));
  return `SELECT 'bounty_event' AS kind, seq, room_id, at, type, bounty_id, actor_id, data, NULL AS body
    FROM bounty_events WHERE ${conds.join(" AND ")}`;
}

function eventBranch(selectors, params) {
  const conds = [];
  if (selectors.room !== undefined) { conds.push("room_id = ?"); params.push(selectors.room); }
  if (selectors.subject !== undefined) {
    conds.push("(json_extract(body,'$.data.bountyId') = ? OR json_extract(body,'$.data.workClaim') = ? OR json_extract(body,'$.data.subject') = ?)");
    params.push(selectors.subject, selectors.subject, selectors.subject);
  }
  if (selectors.credential !== undefined) {
    conds.push(`(json_extract(body,'$.data.ownerId') = ? OR json_extract(body,'$.data.actor') = ?
      OR json_extract(body,'$.data.claimant') = ? OR json_extract(body,'$.data.earner') = ?
      OR json_extract(body,'$.actor.id') = ?)`);
    for (let i = 0; i < 5; i++) params.push(selectors.credential);
  }
  if (selectors.version !== undefined) conds.push(versionCond("body", VERSION_PATHS_EVENT, params, selectors.version));
  return `SELECT 'room_event' AS kind, sequence AS seq, room_id,
      json_extract(body,'$.at') AS at, json_extract(body,'$.type') AS type,
      NULL AS bounty_id, NULL AS actor_id, NULL AS data, body
    FROM events WHERE ${conds.join(" AND ")}`;
}

const strOrNull = value => typeof value === "string" && value.length > 0 ? value : null;
const versionOfData = data => {
  for (const key of ["rubricVersion", "termsVersion", "rubric_version"]) {
    const value = data?.[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (Number.isInteger(value)) return String(value);
  }
  return null;
};
const atMsOf = value => {
  if (Number.isInteger(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function runRecord(row) {
  if (row.kind === "bounty_event") {
    let data = {};
    try { data = JSON.parse(row.data ?? "{}") ?? {}; } catch { data = {}; }
    return Object.freeze({
      kind: row.kind, id: `bounty_event:${row.room_id}:${row.seq}`,
      roomId: row.room_id, seq: row.seq, at: atMsOf(row.at), type: row.type,
      subject: strOrNull(row.bounty_id), credential: strOrNull(row.actor_id),
      version: versionOfData(data)
    });
  }
  let parsed = {};
  try { parsed = JSON.parse(row.body ?? "{}") ?? {}; } catch { parsed = {}; }
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  return Object.freeze({
    kind: row.kind, id: `room_event:${row.room_id}:${row.seq}`,
    roomId: row.room_id, seq: row.seq, at: atMsOf(parsed.at), type: strOrNull(parsed.type),
    subject: strOrNull(data.bountyId) ?? strOrNull(data.workClaim) ?? strOrNull(data.subject),
    credential: strOrNull(data.ownerId) ?? strOrNull(data.actor) ?? strOrNull(data.claimant)
      ?? strOrNull(data.earner) ?? strOrNull(parsed.actor?.id),
    version: versionOfData(data)
  });
}

// THE enumeration read: every run record touched by the selector, in one
// query over the durable record tables that exist. Selector dimensions
// combine with AND; a dimension the selector does not name does not
// filter. Returns frozen run records ordered by (at, kind, seq).
export function enumerateBySelectors(db, selectors) {
  const clean = normalizeSelectors(selectors);
  const branches = [];
  const params = [];
  if (hasTable(db, "bounty_events")) branches.push(bountyBranch(clean, params));
  if (hasTable(db, "events")) branches.push(eventBranch(clean, params));
  if (branches.length === 0) return Object.freeze([]);
  const rows = db.prepare(`${branches.join(" UNION ALL ")} ORDER BY kind, seq`).all(...params);
  const records = rows.map(runRecord);
  records.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(records);
}

// Materialize the link from every affected record to the incident, so an
// affected record carries its incident link (incidentsForRecord) and the
// incident's affected set is itself a stored, queryable record set.
// Idempotent: re-linking inserts nothing twice.
export function linkIncident(db, incidentId, { at = null } = {}) {
  ensureIncidentRecordsSchema(db);
  const incident = getIncident(db, incidentId);
  const now = at === null ? Date.now() : msOf(at, "at");
  const records = enumerateBySelectors(db, incident.selectors);
  const insert = db.prepare(`INSERT OR IGNORE INTO incident_record_links
    (incident_id, record_kind, record_id, room_id, subject, credential, version, record_at, linked_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let linked = 0;
  for (const record of records) {
    linked += insert.run(incidentId, record.kind, record.id, record.roomId, record.subject,
      record.credential, record.version, record.at, now).changes;
  }
  return Object.freeze({ incidentId, matched: records.length, linked, records });
}

// One query: the incident's affected records, from the materialized links.
export function enumerateIncident(db, incidentId) {
  ensureIncidentRecordsSchema(db);
  getIncident(db, incidentId);
  const rows = db.prepare(`SELECT record_kind, record_id, room_id, subject, credential, version, record_at
    FROM incident_record_links WHERE incident_id=? ORDER BY record_at, record_id`).all(incidentId);
  return Object.freeze(rows.map(row => Object.freeze({
    kind: row.record_kind, id: row.record_id, roomId: row.room_id, subject: row.subject,
    credential: row.credential, version: row.version, at: row.record_at
  })));
}

// The link from an affected record's side: every incident linked to it.
export function incidentsForRecord(db, recordKind, recordId) {
  ensureIncidentRecordsSchema(db);
  textOf(recordKind, "recordKind");
  textOf(recordId, "recordId");
  const rows = db.prepare(`SELECT i.* FROM incidents i
    JOIN incident_record_links l ON l.incident_id = i.id
    WHERE l.record_kind=? AND l.record_id=? ORDER BY i.opened_at, i.id`).all(recordKind, recordId);
  return Object.freeze(rows.map(incidentView));
}

// --- performance aggregates ---------------------------------------------------

const emptyTally = () => ({
  submissionAccepted: 0, submissionsRejected: 0, claimJudgedBad: 0,
  claimCompleted: 0, claimFlaked: 0, disputeWon: 0, disputeLost: 0,
  acceptanceOverturned: 0, bondForfeited: 0, payoutReleased: 0
});
// Signal type -> tally field. Every count below is produced by the
// projector folds; this map only names where a fold output lands.
const SIGNAL_TALLY_FIELDS = Object.freeze({
  submission_accepted: "submissionAccepted",
  claim_judged_bad: "claimJudgedBad",
  claim_completed: "claimCompleted",
  claim_flaked: "claimFlaked",
  dispute_won: "disputeWon",
  dispute_lost: "disputeLost",
  acceptance_overturned: "acceptanceOverturned",
  bond_forfeited: "bondForfeited",
  payout_released: "payoutReleased"
});

const rate = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;

function aggregateRecord({ subjectKind, subjectId, roomId, windowName, windowFromMs, windowToMs, asOfMs, tally, incidentCount }) {
  const judgedSubmissions = tally.submissionAccepted + tally.submissionsRejected + tally.claimJudgedBad;
  const disputeOutcomes = tally.disputeWon + tally.disputeLost;
  const inputs = Object.freeze({ ...tally, judgedSubmissions, disputeOutcomes });
  return Object.freeze({
    id: `agg:${subjectKind}:${subjectId}:${roomId}:${windowName}:${windowFromMs}:${windowToMs}`,
    subjectKind, subjectId, roomId,
    window: windowName, windowFromMs, windowToMs, asOfMs,
    acceptanceRate: rate(tally.submissionAccepted, judgedSubmissions),
    reversalRate: rate(tally.acceptanceOverturned, tally.submissionAccepted + tally.acceptanceOverturned),
    disputeRate: rate(disputeOutcomes, judgedSubmissions + disputeOutcomes),
    incidentCount, inputs
  });
}

// Pure fold -> aggregate records (one per agent observed in the folds, plus
// the room record). bountyEvents are escrow event rows ({ type, data, at,
// seq }); claimRows are claim-projector rows ({ roomId, seq, atMs, data })
// folded by deriveClaimSignals over the FULL row set (positions are
// stateful), with only signals inside the window counted. incidentLinks
// are link-shaped rows ({ incidentId, incidentOpenedAtMs, roomId,
// credential }) — in production they come from incident_record_links
// joined to incidents; the count is over distinct incidents.
export function computePerformanceAggregates({ roomId, bountyEvents = [], claimRows = [], incidentLinks = [],
  windowName, asOfMs } = {}) {
  textOf(roomId, "roomId");
  check(Object.hasOwn(AGGREGATE_WINDOWS, windowName), "invalid_window",
    `windowName must be one of ${Object.keys(AGGREGATE_WINDOWS).join("/")}`);
  msOf(asOfMs, "asOfMs");
  const windowToMs = asOfMs;
  const windowFromMs = asOfMs - AGGREGATE_WINDOWS[windowName];
  const inWindow = ms => Number.isInteger(ms) && ms >= windowFromMs && ms < windowToMs;

  const tallies = new Map();
  const tallyFor = agent => {
    if (!tallies.has(agent)) tallies.set(agent, emptyTally());
    return tallies.get(agent);
  };
  const applySignal = (agent, type) => {
    const field = SIGNAL_TALLY_FIELDS[type];
    if (field) tallyFor(agent)[field] += 1;
  };

  for (const event of bountyEvents) {
    if (!inWindow(atMsOf(event?.at))) continue;
    const signals = signalsForEvent(event);
    for (const s of signals) applySignal(s.agent, s.type);
    // A bounty.rejected event's bond_forfeited signal IS the projector's
    // rejected-submission outcome; name it as such for the acceptance
    // denominator (the signal itself is still the projector's).
    if (event.type === "bounty.rejected")
      for (const s of signals) if (s.type === "bond_forfeited") tallyFor(s.agent).submissionsRejected += 1;
  }
  for (const s of deriveClaimSignals(claimRows)) {
    if (inWindow(s.at)) applySignal(s.agent, s.type);
  }

  const agentIncidents = new Map();
  const roomIncidents = new Set();
  for (const link of incidentLinks) {
    if (!inWindow(link.incidentOpenedAtMs)) continue;
    if (link.roomId === roomId) roomIncidents.add(link.incidentId);
    if (typeof link.credential === "string" && link.credential.length > 0) {
      if (!agentIncidents.has(link.credential)) agentIncidents.set(link.credential, new Set());
      agentIncidents.get(link.credential).add(link.incidentId);
    }
  }

  const roomTally = emptyTally();
  const records = [];
  for (const [agent, tally] of [...tallies.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const key of Object.keys(roomTally)) roomTally[key] += tally[key];
    records.push(aggregateRecord({
      subjectKind: "agent", subjectId: agent, roomId, windowName, windowFromMs, windowToMs,
      asOfMs, tally, incidentCount: agentIncidents.get(agent)?.size ?? 0
    }));
  }
  records.push(aggregateRecord({
    subjectKind: "room", subjectId: roomId, roomId, windowName, windowFromMs, windowToMs,
    asOfMs, tally: roomTally, incidentCount: roomIncidents.size
  }));
  return Object.freeze(records);
}

const aggregateView = row => Object.freeze({
  id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, roomId: row.room_id,
  window: row.window_name, windowFromMs: row.window_from_ms, windowToMs: row.window_to_ms,
  asOfMs: row.as_of_ms, acceptanceRate: row.acceptance_rate, reversalRate: row.reversal_rate,
  disputeRate: row.dispute_rate, incidentCount: row.incident_count,
  inputs: Object.freeze(JSON.parse(row.inputs))
});

// Store computed aggregate records as first-class records. Re-storing the
// same (subject, room, window, bounds) replaces the row — the record is
// the current fold at its as-of, and its inputs keep it recomputable.
export function storePerformanceAggregates(db, records) {
  ensureIncidentRecordsSchema(db);
  const insert = db.prepare(`INSERT OR REPLACE INTO performance_aggregates
    (id, subject_kind, subject_id, room_id, window_name, window_from_ms, window_to_ms,
     as_of_ms, acceptance_rate, reversal_rate, dispute_rate, incident_count, inputs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of records) {
    insert.run(r.id, r.subjectKind, r.subjectId, r.roomId, r.window, r.windowFromMs, r.windowToMs,
      r.asOfMs, r.acceptanceRate, r.reversalRate, r.disputeRate, r.incidentCount, JSON.stringify(r.inputs));
  }
  return Object.freeze(records.map(r => getPerformanceAggregate(db,
    { subjectKind: r.subjectKind, subjectId: r.subjectId, roomId: r.roomId, windowName: r.window })));
}

export function getPerformanceAggregate(db, { subjectKind, subjectId, roomId, windowName } = {}) {
  ensureIncidentRecordsSchema(db);
  const row = db.prepare(`SELECT * FROM performance_aggregates
    WHERE subject_kind=? AND subject_id=? AND room_id=? AND window_name=?
    ORDER BY as_of_ms DESC LIMIT 1`).get(subjectKind, subjectId, roomId, windowName);
  return row ? aggregateView(row) : null;
}

export function listPerformanceAggregates(db, { subjectKind = null, roomId = null } = {}) {
  ensureIncidentRecordsSchema(db);
  const rows = db.prepare(`SELECT * FROM performance_aggregates
    WHERE (? IS NULL OR subject_kind=?) AND (? IS NULL OR room_id=?)
    ORDER BY subject_kind, subject_id, window_name`).all(subjectKind, subjectKind, roomId, roomId);
  return Object.freeze(rows.map(aggregateView));
}

// One-call materialization for a room whose durable tables are co-located
// in `db` (the shape the tests seed, and the shape of a room store that
// also holds bounty_events): read the event records, fold them with the
// projectors, store the aggregate records. Where the tables live in
// separate databases, call computePerformanceAggregates() with the rows
// and storePerformanceAggregates() on the target db instead.
export function syncPerformanceAggregates(db, { roomId, windowName, asOfMs } = {}) {
  ensureIncidentRecordsSchema(db);
  const bountyEvents = hasTable(db, "bounty_events")
    ? db.prepare("SELECT seq, at, type, data FROM bounty_events WHERE room_id=? ORDER BY seq").all(roomId)
      .map(row => {
        let data = {};
        try { data = JSON.parse(row.data ?? "{}") ?? {}; } catch { data = {}; }
        return { seq: row.seq, at: row.at, type: row.type, data };
      })
    : [];
  const claimRows = hasTable(db, "events")
    ? db.prepare(`SELECT room_id, sequence, body FROM events
        WHERE room_id=? AND json_extract(body,'$.type')='work_claim.updated' ORDER BY sequence`).all(roomId)
      .flatMap(row => {
        try {
          const body = JSON.parse(row.body);
          const atMs = Date.parse(body?.at);
          if (!body?.data || typeof body.data !== "object" || !Number.isFinite(atMs)) return [];
          return [{ roomId: row.room_id, seq: row.sequence, atMs, data: body.data }];
        } catch { return []; }
      })
    : [];
  const incidentLinks = db.prepare(`SELECT l.incident_id AS incidentId, i.opened_at AS incidentOpenedAtMs,
      l.room_id AS roomId, l.credential AS credential
    FROM incident_record_links l JOIN incidents i ON i.id = l.incident_id`).all();
  const records = computePerformanceAggregates({ roomId, bountyEvents, claimRows, incidentLinks, windowName, asOfMs });
  return storePerformanceAggregates(db, records);
}

export { IncidentRecordError };
