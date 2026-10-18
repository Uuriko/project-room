// Incident linkage for consequential records (#3618, accountability R-10).
//
// After any incident — a leaked credential, a bad model/harness version, a
// compromised room, a misbehaving subject — the room must be able to answer,
// in ONE query: which runs/records did this touch? For customer-notification
// SLAs and serious-incident reporting alike. Before this module there was
// no incident entity, flag, or link on work/verdict/money records, and no
// query that enumerated affected runs by credential, version, room, or
// subject; the incident-adjacent systems (SLA alerts, spam quarantine,
// abuse reports, integrity jobs) never linked back to affected runs.
//
// Design: an incident is a first-class stored record carrying SELECTORS.
// Affected records are never rewritten to carry the link — their stored
// shape stays exactly as written. Instead this module extracts, from the
// fields a record already carries, the selector values that name it, and
// stores a separate link/index record per (incident, record, matched
// selector). Enumeration is then either a pure scan (enumerateBySelector /
// enumerateIncident over a record list) or a read of the stored links
// (enumerateFromLinks / the SQLite journal below) — both return exactly
// the affected set, no more, no less.
//
// Selector kinds (the issue's four, plus the provenance session):
//   credential — credentialId / apiKeyId a record was produced under
//   version    — claimedModelVersion / claimedHarnessVersion (the caller-
//                reported runtime claims pinned by #3612, PR #4041),
//                modelVersion / harnessVersion, rubricVersion,
//                termsVersion, policyVersion, version
//   room       — roomId
//   subject    — subjectId / agentId / actorId / identityId / claimant /
//                earner / verifier, and the provenance stamp's
//                authorizingPrincipalId (the human principal, #3612)
//   session    — sessionInstanceId, top-level or in the provenance stamp
//                (server/records-provenance.mjs on the #3612 branch:
//                sess_ ids derived by the server at write time)
//
// Storage follows the claim-reputation precedent (server/claim-reputation.mjs):
// additive SQLite tables created on demand by tooling, registered in
// server/writer-fence.mjs (lazyAdditiveTables) — allowed, never required.
// Pure parts (codec, extraction, enumeration, link building, incident
// counting) take plain values and never touch a database.
import { createHash, randomBytes } from "node:crypto";

export class IncidentRecordError extends Error {
  constructor(code, message) { super(message); this.name = "IncidentRecordError"; this.code = code; }
}
const fail = (code, message) => { throw new IncidentRecordError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_incident_record", message); };

export const INCIDENT_SELECTOR_KINDS = Object.freeze(["credential", "version", "room", "subject", "session"]);
export const INCIDENT_SEVERITIES = Object.freeze(["sev1", "sev2", "sev3", "sev4"]);
export const INCIDENT_STATUSES = Object.freeze(["open", "closed"]);

const MAX_TEXT = 500;
const cleanText = (value, field, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    check(!required, `${field} is required`);
    return null;
  }
  check(typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT
    && !/[\x00-\x1f\x7f]/.test(value), `${field} must be a string of 1..${MAX_TEXT} characters without control characters`);
  return value.trim();
};
const cleanMs = (value, field) => {
  check(Number.isInteger(value) && value >= 0, `${field} must be a non-negative integer ms timestamp`);
  return value;
};

// --- selectors ---------------------------------------------------------------

export function selectorOf(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "selector must be an object");
  check(INCIDENT_SELECTOR_KINDS.includes(value.kind),
    `selector kind must be one of ${INCIDENT_SELECTOR_KINDS.join(", ")}`);
  const selectorValue = cleanText(value.value, "selector value", { required: true });
  return Object.freeze({ kind: value.kind, value: selectorValue });
}

export function normalizeSelectors(values) {
  check(Array.isArray(values) && values.length >= 1, "an incident needs at least one selector");
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const selector = selectorOf(raw);
    const key = `${selector.kind}\n${selector.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(selector);
  }
  return Object.freeze(out);
}

const selectorKey = selector => `${selector.kind}:${selector.value}`;

// --- the incident record -----------------------------------------------------

export function newIncidentId() {
  return `inc_${randomBytes(9).toString("hex")}`;
}

export function createIncident(input) {
  check(input && typeof input === "object" && !Array.isArray(input), "incident input must be an object");
  const incidentId = input.incidentId === undefined || input.incidentId === null
    ? newIncidentId() : cleanText(input.incidentId, "incidentId", { required: true });
  check(/^inc_[A-Za-z0-9_-]+$/.test(incidentId), "incidentId must start with inc_");
  const openedAtMs = cleanMs(input.openedAtMs, "openedAtMs");
  const severity = input.severity === undefined || input.severity === null ? null : input.severity;
  check(severity === null || INCIDENT_SEVERITIES.includes(severity),
    `severity must be one of ${INCIDENT_SEVERITIES.join(", ")}`);
  return Object.freeze({
    incidentId,
    title: cleanText(input.title, "title", { required: true }),
    summary: cleanText(input.summary, "summary"),
    severity,
    status: "open",
    openedAtMs,
    openedBy: cleanText(input.openedBy, "openedBy", { required: true }),
    closedAtMs: null,
    closedBy: null,
    selectors: normalizeSelectors(input.selectors),
  });
}

// Validate/normalize an incident as stored. Records written by
// createIncident round-trip exactly; malformed shapes fail closed.
export function incidentOf(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "incident must be an object");
  const status = value.status ?? "open";
  check(INCIDENT_STATUSES.includes(status), `incident status must be one of ${INCIDENT_STATUSES.join(", ")}`);
  const openedAtMs = cleanMs(value.openedAtMs, "openedAtMs");
  const closedAtMs = value.closedAtMs === undefined || value.closedAtMs === null
    ? null : cleanMs(value.closedAtMs, "closedAtMs");
  if (status === "closed") check(closedAtMs !== null && closedAtMs >= openedAtMs, "a closed incident needs closedAtMs >= openedAtMs");
  if (status === "open") check(closedAtMs === null, "an open incident cannot carry closedAtMs");
  const severity = value.severity ?? null;
  check(severity === null || INCIDENT_SEVERITIES.includes(severity),
    `severity must be one of ${INCIDENT_SEVERITIES.join(", ")}`);
  check(typeof value.incidentId === "string" && /^inc_[A-Za-z0-9_-]+$/.test(value.incidentId),
    "incidentId must start with inc_");
  return Object.freeze({
    incidentId: value.incidentId,
    title: cleanText(value.title, "title", { required: true }),
    summary: cleanText(value.summary, "summary"),
    severity,
    status,
    openedAtMs,
    openedBy: cleanText(value.openedBy, "openedBy", { required: true }),
    closedAtMs,
    closedBy: cleanText(value.closedBy, "closedBy"),
    selectors: normalizeSelectors(value.selectors),
  });
}

export function closeIncident(incident, { closedAtMs, closedBy } = {}) {
  const current = incidentOf(incident);
  check(current.status === "open", `incident ${current.incidentId} is already closed`);
  const at = cleanMs(closedAtMs, "closedAtMs");
  check(at >= current.openedAtMs, "closedAtMs must not precede openedAtMs");
  return incidentOf({ ...current, status: "closed", closedAtMs: at, closedBy: cleanText(closedBy, "closedBy", { required: true }) });
}

// --- selector extraction from records as already stored ----------------------

const asText = value => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

function push(out, kind, value) {
  const text = asText(value);
  if (text !== null) out.push(Object.freeze({ kind, value: text }));
}

// Every selector value a record carries, in a fixed kind order, deduped.
// Reads ONLY fields records already carry — top-level fields and the
// #3612 provenance stamp (record.provenance). A record that predates the
// stamp simply contributes fewer values; nothing is guessed or invented.
export function recordSelectorValues(record) {
  check(record && typeof record === "object" && !Array.isArray(record), "record must be an object");
  const provenance = record.provenance && typeof record.provenance === "object" && !Array.isArray(record.provenance)
    ? record.provenance : {};
  const out = [];
  push(out, "credential", record.credentialId);
  push(out, "credential", record.apiKeyId);
  push(out, "credential", record.actorCredentialId);
  for (const field of ["claimedModelVersion", "claimedHarnessVersion", "modelVersion", "harnessVersion",
    "rubricVersion", "termsVersion", "policyVersion", "version"]) push(out, "version", record[field]);
  push(out, "version", provenance.claimedModelVersion);
  push(out, "version", provenance.claimedHarnessVersion);
  push(out, "room", record.roomId);
  for (const field of ["subjectId", "agentId", "actorId", "identityId", "claimant", "earner", "verifier", "poster"])
    push(out, "subject", record[field]);
  push(out, "subject", provenance.authorizingPrincipalId);
  push(out, "session", record.sessionInstanceId);
  push(out, "session", provenance.sessionInstanceId);
  const seen = new Set();
  return Object.freeze(out.filter(selector => {
    const key = selectorKey(selector);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function recordIdOf(record) {
  for (const field of ["recordId", "id", "bountyId", "claimId", "receiptId", "settlementId", "eventId"]) {
    const text = asText(record?.[field]);
    if (text !== null) return text;
  }
  return null;
}

export function recordKindOf(record) {
  return asText(record?.kind) ?? asText(record?.type) ?? "record";
}

export function recordMatchesSelector(record, selector) {
  const wanted = selectorOf(selector);
  return recordSelectorValues(record).some(candidate =>
    candidate.kind === wanted.kind && candidate.value === wanted.value);
}

// --- enumeration reads ---------------------------------------------------------

// THE R-10 read: given ONE selector, every affected record in one query.
// Deterministic order (by recordId, records without an id last in input
// order) so notification lists are stable across calls.
export function enumerateBySelector(records, selector) {
  check(Array.isArray(records), "records must be an array");
  const wanted = selectorOf(selector);
  const matched = records.filter(record => record && typeof record === "object" && recordMatchesSelector(record, wanted));
  const sorted = [...matched].sort((a, b) => String(recordIdOf(a) ?? "").localeCompare(String(recordIdOf(b) ?? "")));
  return Object.freeze({
    selector: wanted,
    records: Object.freeze(sorted),
    recordIds: Object.freeze(sorted.map(recordIdOf)),
  });
}

// Every record touched by ANY of an incident's selectors — the incident-
// notification query. bySelector keeps the per-selector breakdown so a
// responder can see WHY each record is in the set.
export function enumerateIncident(records, incident) {
  const normalized = incidentOf(incident);
  const bySelector = {};
  const byId = new Map();
  for (const selector of normalized.selectors) {
    const result = enumerateBySelector(records, selector);
    bySelector[selectorKey(selector)] = result.recordIds;
    for (const record of result.records) {
      const id = recordIdOf(record);
      if (id !== null && !byId.has(id)) byId.set(id, record);
    }
  }
  const affected = [...byId.values()].sort((a, b) => String(recordIdOf(a)).localeCompare(String(recordIdOf(b))));
  return Object.freeze({
    incidentId: normalized.incidentId,
    records: Object.freeze(affected),
    recordIds: Object.freeze(affected.map(recordIdOf)),
    bySelector: Object.freeze(bySelector),
  });
}

// --- link/index records --------------------------------------------------------

// Build the stored links for an incident over a record list: one link per
// (record, matched selector). The source records are not modified — the
// link IS the association, keyed by the selector values the records
// already carry.
export function buildIncidentLinks(incident, records, { linkedAtMs, linkedBy } = {}) {
  const normalized = incidentOf(incident);
  check(Array.isArray(records), "records must be an array");
  const at = cleanMs(linkedAtMs, "linkedAtMs");
  const by = cleanText(linkedBy, "linkedBy", { required: true });
  const links = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const recordId = recordIdOf(record);
    if (recordId === null) continue; // an id-less record cannot be linked or notified against
    const carried = new Set(recordSelectorValues(record).map(selectorKey));
    for (const selector of normalized.selectors) {
      if (!carried.has(selectorKey(selector))) continue;
      links.push(Object.freeze({
        incidentId: normalized.incidentId,
        recordId,
        recordKind: recordKindOf(record),
        selectorKind: selector.kind,
        selectorValue: selector.value,
        linkedAtMs: at,
        linkedBy: by,
      }));
    }
  }
  links.sort((a, b) => a.recordId.localeCompare(b.recordId)
    || a.selectorKind.localeCompare(b.selectorKind) || a.selectorValue.localeCompare(b.selectorValue));
  return Object.freeze(links);
}

export function linkOf(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "link must be an object");
  check(typeof value.incidentId === "string" && value.incidentId.length > 0, "link incidentId is required");
  const selector = selectorOf({ kind: value.selectorKind, value: value.selectorValue });
  return Object.freeze({
    incidentId: value.incidentId,
    recordId: cleanText(value.recordId, "link recordId", { required: true }),
    recordKind: cleanText(value.recordKind, "link recordKind") ?? "record",
    selectorKind: selector.kind,
    selectorValue: selector.value,
    linkedAtMs: cleanMs(value.linkedAtMs, "linkedAtMs"),
    linkedBy: cleanText(value.linkedBy, "linkedBy", { required: true }),
  });
}

// Enumeration from stored links alone (the journal read): exactly the
// records linked to this incident, deduped across selectors.
export function enumerateFromLinks(links, incidentId) {
  check(Array.isArray(links), "links must be an array");
  check(typeof incidentId === "string" && incidentId.length > 0, "incidentId is required");
  const mine = links.map(linkOf).filter(link => link.incidentId === incidentId);
  const recordIds = [...new Set(mine.map(link => link.recordId))].sort();
  return Object.freeze({ incidentId, recordIds: Object.freeze(recordIds), links: Object.freeze(mine) });
}

// Distinct-incident counts per aggregate subject (R-12's incident count).
// Keys are `agent:<subjectId>` for every subject value a linked record
// carries and `room:<roomId>` for its room. A record linked to one
// incident under two selectors still counts that incident ONCE.
export function incidentCountsBySubject(links, recordsById) {
  check(Array.isArray(links), "links must be an array");
  check(recordsById instanceof Map, "recordsById must be a Map of recordId -> record");
  const perKey = new Map(); // key -> Set(incidentId)
  const add = (key, incidentId) => {
    if (!perKey.has(key)) perKey.set(key, new Set());
    perKey.get(key).add(incidentId);
  };
  for (const raw of links) {
    const link = linkOf(raw);
    const record = recordsById.get(link.recordId);
    if (!record) continue;
    for (const selector of recordSelectorValues(record)) {
      if (selector.kind === "subject") add(`agent:${selector.value}`, link.incidentId);
      if (selector.kind === "room") add(`room:${selector.value}`, link.incidentId);
    }
  }
  const out = new Map();
  for (const [key, incidents] of perKey) out.set(key, incidents.size);
  return out;
}

// --- SQLite journal (stored records) ------------------------------------------

export const INCIDENT_RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS incident_records (
  incident_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  opened_ms INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incident_links (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  selector_kind TEXT NOT NULL,
  selector_value TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_links_incident ON incident_links(incident_id);
CREATE INDEX IF NOT EXISTS incident_links_selector ON incident_links(selector_kind, selector_value);
CREATE INDEX IF NOT EXISTS incident_links_record ON incident_links(record_id);
`;

export function ensureIncidentRecordsSchema(db) {
  db.exec(INCIDENT_RECORDS_SCHEMA);
}

const linkId = link => `incl_${createHash("sha256")
  .update([link.incidentId, link.recordId, link.selectorKind, link.selectorValue].join("\n"), "utf8")
  .digest("hex").slice(0, 24)}`;

export function storeIncident(db, incident) {
  ensureIncidentRecordsSchema(db);
  const normalized = incidentOf(incident);
  db.prepare(`INSERT INTO incident_records (incident_id, status, opened_ms, body) VALUES (?,?,?,?)
    ON CONFLICT(incident_id) DO UPDATE SET status=excluded.status, body=excluded.body`)
    .run(normalized.incidentId, normalized.status, normalized.openedAtMs, JSON.stringify(normalized));
  return normalized;
}

export function getIncident(db, incidentId) {
  ensureIncidentRecordsSchema(db);
  const row = db.prepare("SELECT body FROM incident_records WHERE incident_id=?").get(incidentId);
  return row ? incidentOf(JSON.parse(row.body)) : null;
}

export function listIncidents(db, { status = null } = {}) {
  ensureIncidentRecordsSchema(db);
  const rows = status
    ? db.prepare("SELECT body FROM incident_records WHERE status=? ORDER BY opened_ms, incident_id").all(status)
    : db.prepare("SELECT body FROM incident_records ORDER BY opened_ms, incident_id").all();
  return Object.freeze(rows.map(row => incidentOf(JSON.parse(row.body))));
}

// Idempotent: re-storing the same links writes nothing twice (the link id
// is a hash of its identity fields).
export function storeIncidentLinks(db, links) {
  ensureIncidentRecordsSchema(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO incident_links
    (id, incident_id, record_id, selector_kind, selector_value, body) VALUES (?,?,?,?,?,?)`);
  let written = 0;
  const writeOne = raw => {
    const link = linkOf(raw);
    written += insert.run(linkId(link), link.incidentId, link.recordId,
      link.selectorKind, link.selectorValue, JSON.stringify(link)).changes;
  };
  const write = db.transaction
    ? db.transaction(list => { for (const link of list) writeOne(link); })
    : (list => { for (const link of list) writeOne(link); });
  write(links);
  return { linksWritten: written };
}

export function listIncidentLinks(db, incidentId) {
  ensureIncidentRecordsSchema(db);
  const rows = incidentId
    ? db.prepare("SELECT body FROM incident_links WHERE incident_id=? ORDER BY record_id, selector_kind, selector_value").all(incidentId)
    : db.prepare("SELECT body FROM incident_links ORDER BY incident_id, record_id, selector_kind, selector_value").all();
  return Object.freeze(rows.map(row => linkOf(JSON.parse(row.body))));
}

export function enumerateIncidentFromStore(db, incidentId) {
  return enumerateFromLinks([...listIncidentLinks(db, incidentId)], incidentId);
}
