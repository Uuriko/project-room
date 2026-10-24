// Durable Object export. The on-disk server copies its sqlite file
// (scripts/backup-room.mjs). A Durable Object cannot hand that file out, so
// this streams the same store as NDJSON and replays it into a fresh file.
// The secret columns named in EXPORT_SECRET_COLUMNS and raw token shapes
// inside other cells are sha256 hex. Everything else round-trips verbatim.
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RoomStore } from "./store.mjs";
import { auditRecovery } from "./recovery.mjs";
import { Buffer } from "node:buffer";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TOKEN_SOURCE = "(?:pri_|rak_|ga1\\.)[A-Za-z0-9_-]{8,}";
const FIRST = ["accounts", "rooms", "events", "commands", "member_accounts", "account_access_events", "credentials", "account_credentials", "account_session_slots", "cursors", "projection_checkpoints"];

const sha256Hex = value => createHash("sha256").update(value).digest("hex");

function quoteIdent(name) {
  if (!IDENT.test(name)) throw new Error("Export names a table or column this store will not write");
  return `"${name}"`;
}

// #3599: the columns whose values are secret material, named exactly per
// table. Exports replace them with a sha256 placeholder; restores never
// load the placeholder as a live value (see createSanitizedCellTracker).
// This exact set replaces a name regex that also hashed two columns
// holding no secrets at all — accounts.password_reset_required (an
// INTEGER 0/1 flag) and bounty_records.verifier (a member lane id:
// approval authority) — silently corrupting both on every restore. A
// column joins this set only by being named here, never by matching a
// name pattern. Already-hashed columns (hash, *_hash) are digests, not
// secrets, and round-trip as they are; auth_epoch is a counter.
export const EXPORT_SECRET_COLUMNS = Object.freeze({
  account_login_methods: Object.freeze(["verifier"]),
  agent_push_configs: Object.freeze(["push_token"]),
  agent_webhook_subs: Object.freeze(["secret"]),
  gmail_linked_mailboxes: Object.freeze(["encrypted"]),
  gmail_mailboxes: Object.freeze(["encrypted"]),
  gmail_pending: Object.freeze(["encrypted"]),
  human_push_subscriptions: Object.freeze(["auth", "p256dh"]),
  oauth_pending_states: Object.freeze(["slot_token", "verifier"]),
  public_rooms: Object.freeze(["join_token"]),
  referral_invite_keys: Object.freeze(["private_seed"])
});
const SECRET_COLUMN_SETS = new Map(Object.entries(EXPORT_SECRET_COLUMNS)
  .map(([table, columns]) => [table, new Set(columns)]));

export function isExportSecretColumn(table, column) {
  return SECRET_COLUMN_SETS.get(table)?.has(column) ?? false;
}

// Watermark marker for exports written under the exact policy above.
// Streams without it were written by the pre-#3599 name-regex exporter
// and are "legacy" to every restore (see createSanitizedCellTracker).
export const BACKUP_SANITIZE_POLICY = 2;

function scrubTokens(value) {
  return value.replace(new RegExp(TOKEN_SOURCE, "g"), match => sha256Hex(match));
}

export function sanitizeCell(table, column, value) {
  if (value === null || value === undefined) return null;
  if (isExportSecretColumn(table, column)) return sha256Hex(typeof value === "string" ? value : String(value));
  // REL-14: BLOB cells (room file bytes) leave as base64. JSON.stringify of a
  // Uint8Array is an object of indices that replay could not bind, so any room
  // holding a file produced an export that could not be restored.
  // A Durable Object's SQL API returns BLOB cells as ArrayBuffer, not
  // Uint8Array, and JSON.stringify(ArrayBuffer) is {}: every room file's
  // bytes left production backups as an empty object until this was handled.
  if (value instanceof Uint8Array) return { $base64: Buffer.from(value).toString("base64") };
  if (value instanceof ArrayBuffer) return { $base64: Buffer.from(new Uint8Array(value)).toString("base64") };
  // A bare SharedArrayBuffer is neither an ArrayBuffer nor a view, but
  // JSON.stringify turns it into {} just the same. Encode it like one.
  // (Views over shared memory are already caught by the isView branch.)
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
    return { $base64: Buffer.from(new Uint8Array(value)).toString("base64") };
  if (ArrayBuffer.isView(value)) return { $base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (typeof value !== "string") return value;
  return scrubTokens(value);
}

function sanitizeRow(table, row) {
  const out = {};
  for (const [column, value] of Object.entries(row)) out[column] = sanitizeCell(table, column, value);
  return out;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => row.name).filter(name => IDENT.test(name));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(column => column.name);
}

function exportTableOrder(db) {
  const present = new Set(tableNames(db));
  const ordered = FIRST.filter(table => present.has(table));
  for (const table of [...present].sort()) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

// Tables read in keyset pages, never in one .all(): a table dump would
// otherwise hold every row, including every file and message body, in memory
// at once. Pages use .all() because the Durable Object database adapter has no
// iterate(). Row order matches the old unpaged SELECT (rowid order, and the
// parent-first order for credentials), so the output bytes do not change.
// Tables holding large cells use small pages.
const EXPORT_PAGE_ROWS = 500;
const EXPORT_PAGE_ROWS_BY_TABLE = Object.freeze({ room_attachments: 4, events: 100 });

function* exportTableRows(db, table, columns, pageRows) {
  const list = columns.map(quoteIdent).join(", ");
  const name = quoteIdent(table);
  const limit = Math.max(1, Math.min(pageRows, EXPORT_PAGE_ROWS_BY_TABLE[table] ?? pageRows));
  if (table === "credentials" && columns.includes("parent_hash")) {
    // hash is the primary key, so (parent_hash IS NOT NULL, hash) is a unique key.
    const page = db.prepare(`SELECT ${list}, (parent_hash IS NOT NULL) AS "__k" FROM ${name}
      WHERE (parent_hash IS NOT NULL) > ? OR ((parent_hash IS NOT NULL) = ? AND hash > ?)
      ORDER BY parent_hash IS NOT NULL, hash LIMIT ?`);
    let k = -1;
    let hash = "";
    for (;;) {
      const rows = page.all(k, k, hash, limit);
      for (const { __k, ...row } of rows) yield row;
      if (rows.length < limit) return;
      ({ __k: k, hash } = rows.at(-1));
    }
  }
  const withoutRowid = /WITHOUT\s+ROWID/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql ?? "");
  if (withoutRowid || columns.some(column => column.toLowerCase() === "rowid")) {
    // No rowid to page on: read the table whole, as before.
    yield* db.prepare(`SELECT ${list} FROM ${name}`).all();
    return;
  }
  const page = db.prepare(`SELECT rowid AS "__rid", ${list} FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows = page.all(after, limit);
    for (const { __rid, ...row } of rows) yield row;
    if (rows.length < limit) return;
    after = rows.at(-1).__rid;
  }
}

export function* exportNdjsonLines(db, { pageRows = EXPORT_PAGE_ROWS } = {}) {
  const rooms = db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
  const events = db.prepare("SELECT count(*) AS n FROM events").get().n;
  yield JSON.stringify({ kind: "watermark", version: 1, sanitizePolicy: BACKUP_SANITIZE_POLICY, backedUpAt: Date.now(), rooms, events }) + "\n";
  // #3325: pin every loadable table's content in the trailer, accumulated
  // over the sanitized rows exactly as they are yielded below.
  const digests = createTableDigests();
  for (const table of exportTableOrder(db)) {
    const columns = tableColumns(db, table);
    if (!columns.length) continue;
    for (const row of exportTableRows(db, table, columns, pageRows)) {
      const sanitized = sanitizeRow(table, row);
      digests.add(table, sanitized);
      yield JSON.stringify({ table, row: sanitized }) + "\n";
    }
  }
  yield JSON.stringify(exportTrailer(db, digests.finish())) + "\n";
}

// End-of-stream integrity trailer. The watermark is taken before the first
// table is dumped, but the Durable Object serves requests between stream
// pulls, so a write can land mid-stream. The watermark's event count does not
// always see it: a write whose event row misses the events scan but whose
// side effects land in a later-scanned table keeps the dumped count equal to
// the watermark while the data is inconsistent (a torn backup that used to
// replay with verified:true). The trailer re-reads the event log after the
// last table, so replay can refuse a torn export loudly. The hash is over the
// sanitized cells, exactly as the rows were yielded, so a future sanitize
// rule cannot cause a false mismatch. Rooms need no trailer: a room created
// mid-stream fails the events foreign key, and any other room tear moves the
// event count.
const TRAILER_PAGE_ROWS = 2000;
export function exportTrailer(db, tables = null) {
  // Keyset pages, not one .all(): a room with many events would otherwise hold
  // every row in memory at the end of each export. Pages use .all() because the
  // Durable Object database adapter has no iterate().
  const page = db.prepare("SELECT room_id, sequence, id FROM events WHERE room_id > ? OR (room_id = ? AND sequence > ?) ORDER BY room_id, sequence LIMIT ?");
  const hash = createHash("sha256");
  let count = 0;
  let roomId = "";
  let sequence = -1;
  for (;;) {
    const rows = page.all(roomId, roomId, sequence, TRAILER_PAGE_ROWS);
    for (const row of rows) {
      hash.update(`${sanitizeCell("events", "room_id", row.room_id)}\t${sanitizeCell("events", "sequence", row.sequence)}\t${sanitizeCell("events", "id", row.id)}\n`);
    }
    count += rows.length;
    if (rows.length < TRAILER_PAGE_ROWS) break;
    ({ room_id: roomId, sequence } = rows.at(-1));
  }
  const trailer = { kind: "trailer", version: 1, events: count, eventsHash: hash.digest("hex") };
  // Trailer version 2 carries the per-table content digests (#3325). A
  // caller that cannot supply them (a bare event-log read) still gets a
  // version 1 trailer, which restores report at the weaker level.
  if (tables && Object.keys(tables).length) {
    trailer.version = 2;
    trailer.tables = tables;
  }
  return trailer;
}

// Refuses a torn export: the parsed event rows must be exactly the event log
// the trailer saw at end of stream. Older exports have no trailer and replay
// as before (the caller reports trailer: "absent").
export function verifyTrailer(trailer, byTable) {
  const rows = byTable.get("events") ?? [];
  if (rows.length !== trailer.events)
    throw new Error(`Backup is torn: the export holds ${rows.length} events but its trailer counts ${trailer.events}; a write landed mid-export. Re-take the backup.`);
  const tuples = rows.map(row => [row.room_id, row.sequence, row.id]);
  tuples.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const hash = createHash("sha256");
  for (const [roomId, sequence, id] of tuples) hash.update(`${roomId}\t${sequence}\t${id}\n`);
  if (hash.digest("hex") !== trailer.eventsHash)
    throw new Error("Backup is torn: the event log changed during the export (same count, different rows). Re-take the backup.");
  return true;
}

// #3325: the trailer above pins only the event log, so a tampered or
// corrupted non-event row — a credential's expiry, a revoked flag, an
// account's active bit — restored as verified. Trailer version 2 also pins
// every table a restore can load: a sha256 over the sanitized rows exactly
// as yielded (the same treatment the event hash gives event cells), plus
// the row count. Tables no restore path ever loads are excluded on both
// sides: the DO runtime markers and retired tables in REPLAY_SKIPPED_TABLES,
// the claim writer permit (the target's own authority, never the export's),
// and Cloudflare-internal _cf_ tables. (The set itself is defined with
// REPLAY_SKIPPED_TABLES below.)
function contentDigestSkipped(table) {
  return table.startsWith("_cf_") || CONTENT_DIGEST_SKIPPED_TABLES.includes(table);
}

export function createTableDigests() {
  const tables = new Map();
  return {
    add(table, row) {
      if (contentDigestSkipped(table)) return;
      let entry = tables.get(table);
      if (!entry) {
        entry = { hash: createHash("sha256"), rows: 0 };
        tables.set(table, entry);
      }
      entry.hash.update(`${JSON.stringify(row)}\n`);
      entry.rows += 1;
    },
    finish() {
      const out = {};
      for (const [table, entry] of tables) out[table] = { rows: entry.rows, sha256: entry.hash.digest("hex") };
      return out;
    }
  };
}

export function tableDigestsOf(byTable) {
  const digests = createTableDigests();
  for (const [table, rows] of byTable) for (const row of rows) digests.add(table, row);
  return digests.finish();
}

// The restore's content-verification level for a parsed export, named so a
// weaker legacy export never reports the same bare "verified" as a fully
// pinned one: "full" (trailer v2 table digests verified), "events-only"
// (trailer v1: only the event log is pinned), "watermark-only" (no
// trailer at all). Throws when a pinned digest disagrees with the rows the
// export actually holds — the tamper/corruption case.
export function contentVerificationLevel(trailer, computed) {
  if (!trailer) return "watermark-only";
  if (!trailer.tables) return "events-only";
  for (const [table, expected] of Object.entries(trailer.tables)) {
    const actual = computed[table];
    if (!actual)
      throw new Error(`Export trailer pins table ${table} but the export holds no rows for it`);
    if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256)
      throw new Error(`Export table digest does not match for ${table}: the backup's ${table} rows differ from the rows the exporter pinned (tampered or corrupted backup). Re-take the backup.`);
  }
  for (const table of Object.keys(computed))
    if (!Object.hasOwn(trailer.tables, table))
      throw new Error(`Export holds rows for table ${table} that its trailer does not pin`);
  return "full";
}

// Shape gate shared by both NDJSON parsers (here and restore-ndjson.mjs).
export function assertTrailerShape(record) {
  const malformed = () => new Error("Export trailer is malformed");
  if (record.version !== 1 && record.version !== 2) throw malformed();
  if (!Number.isSafeInteger(record.events) || typeof record.eventsHash !== "string" || !/^[0-9a-f]{64}$/.test(record.eventsHash)) throw malformed();
  if (record.version === 2 && record.tables === undefined) throw malformed();
  if (record.tables !== undefined) {
    if (!record.tables || typeof record.tables !== "object" || Array.isArray(record.tables)) throw malformed();
    for (const [table, entry] of Object.entries(record.tables)) {
      if (!IDENT.test(table) || !entry || typeof entry !== "object" || Array.isArray(entry)
        || !Number.isSafeInteger(entry.rows) || entry.rows < 0
        || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw malformed();
    }
  }
}

export function exportNdjsonText(db) {
  return [...exportNdjsonLines(db)].join("");
}

export function exportNdjsonStream(db) {
  const encoder = new TextEncoder();
  const lines = exportNdjsonLines(db);
  return new ReadableStream({
    pull(controller) {
      const next = lines.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    }
  });
}

export function authorizeOperatorExport(authorization, expected) {
  if (typeof expected !== "string" || expected.length < 16) return "unconfigured";
  const match = /^Bearer ([^\s]+)$/i.exec(typeof authorization === "string" ? authorization : "");
  const presented = match?.[1] ?? "";
  const actual = sha256Hex(presented);
  const wanted = sha256Hex(expected);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(wanted)) ? "ok" : "denied";
}

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const ndjsonHeaders = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export function operatorExportResponse(request, token, db) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/operator/export") return null;
  const auth = authorizeOperatorExport(request.headers.get("authorization"), token);
  if (auth === "unconfigured") return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "GET" && request.method !== "HEAD") return jsonResponse(405, { error: { code: "method_not_allowed", message: "Use GET or HEAD" } });
  if (auth === "denied") return jsonResponse(401, { error: { code: "unauthorized", message: "Operator token required" } });
  if (!db) return jsonResponse(503, { error: { code: "unavailable", message: "Export unavailable" } });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: ndjsonHeaders });
  return new Response(exportNdjsonStream(db), { status: 200, headers: ndjsonHeaders });
}

// REL-14: the inverse of sanitizeCell's BLOB encoding. Any other object is
// refused by name instead of failing as an unbindable parameter.
export function cellOf(value) {
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$base64" && typeof value.$base64 === "string") {
    // Buffer.from skips characters it cannot decode; only canonical base64 is a BLOB.
    const bytes = Buffer.from(value.$base64, "base64");
    if (bytes.toString("base64") !== value.$base64) throw new Error("Export BLOB cell is not canonical base64");
    return bytes;
  }
  throw new Error("Export cell is an object that is not an encoded BLOB");
}

// REL-14 (Instinct-3 4534): a file row carries its own byte_length and sha256;
// replay proves the decoded bytes against both, so a tampered BLOB is refused.
export function checkStoredBytes(table, row) {
  if (!(row.bytes instanceof Uint8Array)) return;
  if (typeof row.byte_length === "number" && row.bytes.length !== row.byte_length)
    throw new Error(`Export ${table} row ${row.id ?? "?"} bytes do not match its byte_length`);
  if (typeof row.sha256 === "string" && sha256Hex(row.bytes) !== row.sha256)
    throw new Error(`Export ${table} row ${row.id ?? "?"} bytes do not match its sha256`);
}

// #3599: the restore-side counterpart of the export policy. Every restore
// path resolves each decoded cell through this tracker before inserting
// it, so a sha256 placeholder can never land as a live value:
// - Secret columns (EXPORT_SECRET_COLUMNS): the stream cell is a
//   placeholder, never the secret. It loads as NULL — or "" where the
//   column is NOT NULL — a value that can never function as the original,
//   and the substitution is counted in report(), so the loss is explicit
//   in the restore result and consumers fail closed visibly instead of
//   comparing against a hash string.
// - Legacy streams (watermark without sanitizePolicy 2, written by the
//   pre-#3599 name-regex exporter) also hashed two non-secret columns.
//   accounts.password_reset_required only ever held 0 or 1, whose
//   placeholders are the two known digests, so the true value is
//   recovered exactly; an unrecognized placeholder refuses the restore
//   rather than guessing a security flag. bounty_records.verifier is
//   unrecoverable and loads as NULL, which grants nobody authority
//   (agent mode fails closed with no verifier seated; human mode never
//   consulted it; legacy mode keeps the poster's own authority) — and is
//   counted in report() so the operator can re-appoint a verifier.
// - Everything else loads verbatim.
// The trailer digests (#3325/#3536) are computed over the stream rows
// before this resolution, so they keep pinning the export exactly as
// written; this tracker defines what the restored cells MEAN.
export function createSanitizedCellTracker(db, { legacySanitize = false } = {}) {
  const counts = new Map();
  const notNullByTable = new Map();
  const record = (table, column) => {
    const key = `${table}.${column}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const secretSubstitute = (table, column) => {
    if (!notNullByTable.has(table)) {
      const set = new Set();
      for (const info of db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all())
        if (info.notnull) set.add(info.name);
      notNullByTable.set(table, set);
    }
    return notNullByTable.get(table).has(column) ? "" : null;
  };
  return {
    resolve(table, column, value) {
      if (value === null || value === undefined) return null;
      if (isExportSecretColumn(table, column)) {
        record(table, column);
        return secretSubstitute(table, column);
      }
      if (legacySanitize && table === "accounts" && column === "password_reset_required") {
        record(table, column);
        if (value === sha256Hex("0")) return 0;
        if (value === sha256Hex("1")) return 1;
        throw new Error("Legacy backup holds an unrecognized placeholder in accounts.password_reset_required (the pre-#3599 exporter hashed this flag); refusing to guess its value. Restore from a current backup or repair the cell by hand.");
      }
      if (legacySanitize && table === "bounty_records" && column === "verifier") {
        record(table, column);
        return null;
      }
      return value;
    },
    report() {
      const out = {};
      for (const [key, count] of [...counts.entries()].sort()) {
        const dot = key.indexOf(".");
        (out[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = count;
      }
      return out;
    }
  };
}

function parseExport(ndjson) {
  if (typeof ndjson !== "string" || !ndjson.trim()) throw new Error("Export is empty");
  const byTable = new Map();
  let watermark = null;
  let trailer = null;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error("Export line is not JSON"); }
    if (record?.kind === "watermark") {
      if (watermark) throw new Error("Export has more than one watermark");
      watermark = record;
      continue;
    }
    if (record?.kind === "trailer") {
      if (trailer) throw new Error("Export has more than one trailer");
      assertTrailerShape(record);
      trailer = record;
      continue;
    }
    if (typeof record?.table !== "string" || !record.row || typeof record.row !== "object" || Array.isArray(record.row)) throw new Error("Export line is not a table row");
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }
  if (!watermark || watermark.version !== 1 || !Number.isSafeInteger(watermark.events)) throw new Error("Export is missing its watermark");
  return { watermark, byTable, trailer };
}

function insertOrder(names) {
  const ordered = FIRST.filter(table => names.has(table));
  for (const table of [...names].sort()) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

// Tables a production Durable Object export can carry that a fresh Node
// store never creates. The two runtime markers belong to the Durable Object
// writer fence (cloudflare/storage.mjs) and mean nothing in a sqlite file.
// The retired Emissary tables stay in upgraded databases (no DROP was ever
// issued) but no module reads them. abuse_rate_buckets is rate-limit state
// the Durable Object creates on first use (server/abuse-rate-buckets.mjs); a
// restored store starts with fresh budgets. The wake-accounting tables
// (server/wake-metrics.mjs, #3345) are the same shape: lazily created
// telemetry — outcome counters plus a bounded loss journal — and a restored
// store restarts its accounting window; the reliability STOCK (pending /
// acked / stranded) is derived from the wake tables themselves, which do
// replay. Replay skips these and reports the row counts; the export itself
// still holds the rows.
export const REPLAY_SKIPPED_TABLES = Object.freeze([
  "room_runtime_version", "room_writer_permit",
  "emissary_drops", "emissary_idempotency", "emissary_invite_attribution",
  "emissary_journal", "external_identities", "external_receipts",
  "abuse_rate_buckets", "agent_wake_counters", "agent_wake_failures",
  // TD-0 MCP telemetry (server/analytics/mcp-telemetry.mjs): lazy daily
  // rollups, same treatment as the wake counters — a restored store
  // restarts its telemetry window; the export still holds the rows.
  "mcp_tool_daily"
]);

const CLAIM_PERMIT_TABLE = "public_work_claim_writer_permit";

// #3325: tables excluded from the trailer's content digests (see
// createTableDigests above): exactly the tables no restore path loads.
export const CONTENT_DIGEST_SKIPPED_TABLES = Object.freeze([...REPLAY_SKIPPED_TABLES, CLAIM_PERMIT_TABLE]);

// Replay into a new sqlite file, then run the same checks as backupRoom.
// audit "strict" (default) refuses a store the recovery audit rejects.
// audit "report" still requires the row load, foreign keys, quick_check,
// file bytes and the event count to match, but returns an audit failure
// instead of throwing: the recovery audit replays every room with the
// current reducer, and production rooms written by older code can differ
// from that replay while the live room serves them fine. A disaster
// restore needs the data back and the drift named, not a refusal.
export function replayNdjson(ndjson, filename, { audit = "strict" } = {}) {
  if (audit !== "strict" && audit !== "report") throw new Error("audit must be strict or report");
  if (!filename) throw new Error("Missing replay paths");
  const { watermark, byTable, trailer } = parseExport(ndjson);
  // Fail fast on a torn export, before any store is created: a mid-stream
  // write the watermark could not see must never verify. #3325: the
  // trailer's per-table content digests are computed over the complete
  // parsed stream (before any table is skipped below) and verified with
  // the other post-load checks.
  const trailerState = trailer ? (verifyTrailer(trailer, byTable), "verified") : "absent";
  const computedDigests = tableDigestsOf(byTable);
  const directory = dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(filename)) throw new Error("Refusing to replay into an existing store");
  const store = new RoomStore(filename);
  try {
    // #3599: sanitized cells resolve to safe substitutes, never the
    // placeholder; legacy streams get the legacy resolutions.
    const tracker = createSanitizedCellTracker(store.db, { legacySanitize: watermark.sanitizePolicy !== BACKUP_SANITIZE_POLICY });
    const existing = new Set(tableNames(store.db));
    const skipped = {};
    for (const table of REPLAY_SKIPPED_TABLES) {
      if (existing.has(table) || !byTable.has(table)) continue;
      skipped[table] = byTable.get(table).length;
      byTable.delete(table);
    }
    const order = insertOrder(new Set(byTable.keys()));
    for (const table of order) if (!existing.has(table)) throw new Error("Export names a table this store does not have");
    store.db.exec("PRAGMA foreign_keys=OFF");
    // The public claim fence (server/public-work-claim-fence.mjs) aborts any
    // write to a public namespace's claims unless its permit is open. Replay
    // opens it for the bulk load and closes it again, as at rest; the
    // exported permit row is not replayed.
    const claimPermit = existing.has(CLAIM_PERMIT_TABLE);
    byTable.delete(CLAIM_PERMIT_TABLE);
    const loadOrder = order.filter(table => table !== CLAIM_PERMIT_TABLE);
    store.transaction(() => {
      for (const table of loadOrder) store.db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      if (claimPermit) store.db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=1 WHERE singleton=1`).run();
      for (const table of loadOrder) {
        const rows = byTable.get(table);
        if (table === "credentials") rows.sort((a, b) => Number(a.parent_hash != null) - Number(b.parent_hash != null));
        const columns = tableColumns(store.db, table);
        const known = new Set(columns);
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.some(key => !known.has(key))) throw new Error("Export row does not match the store schema");
          if (!keys.length) continue;
          const cells = Object.fromEntries(keys.map(key => [key, tracker.resolve(table, key, cellOf(row[key]))]));
          checkStoredBytes(table, cells);
          store.db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
            .run(...keys.map(key => cells[key]));
        }
      }
      if (claimPermit) store.db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=0 WHERE singleton=1`).run();
    });
    store.db.exec("PRAGMA foreign_keys=ON");
    if (store.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored store failed foreign key check");
    if (store.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Restored store failed quick_check");
    const events = store.db.prepare("SELECT count(*) AS n FROM events").get().n;
    if (events !== watermark.events) throw new Error("Export watermark does not match the restored event log");
    // #3325: the digest pin is verified after the load, not before it —
    // the load's own per-cell refusals (a non-BLOB object cell, a BLOB
    // whose bytes fail their stored sha256) are the more specific errors
    // and must fire first. A tampered row whose cells are all well-formed
    // (the #3325 probe) loads cleanly and is refused here, before the
    // audits and before verified is ever returned.
    const contentVerification = contentVerificationLevel(trailer, computedDigests);
    let recovery = null, invitations = {}, auditResult = { ok: true };
    try {
      recovery = auditRecovery(store);
      invitations = store.verifyInvitationAudit();
    } catch (error) {
      if (audit === "strict") throw error;
      auditResult = { ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 200) };
    }
    chmodSync(filename, 0o600);
    return { verified: true, events, trailer: trailerState, contentVerification, ...invitations, recovery, audit: auditResult, skippedTables: skipped, sanitizedCells: tracker.report() };
  } finally { store.close(); }
}
