// Durable Object export. The on-disk server copies its sqlite file
// (scripts/backup-room.mjs). A Durable Object cannot hand that file out, so
// this streams the same store as NDJSON and replays it into a fresh file.
// Secret columns and raw token shapes are sha256 hex. Already-hashed columns
// stay as they are.
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

// Already-hashed columns keep their stored digest. `auth` is the web-push
// secret; `auth_epoch` is a counter and must stay a number.
function secretColumn(column) {
  if (column === "hash" || column.endsWith("_hash")) return false;
  if (column === "auth") return true;
  return /secret|token|password|verifier|private_seed|encrypted|refresh|p256dh/i.test(column);
}

function scrubTokens(value) {
  return value.replace(new RegExp(TOKEN_SOURCE, "g"), match => sha256Hex(match));
}

export function sanitizeCell(column, value) {
  if (value === null || value === undefined) return null;
  if (secretColumn(column)) return sha256Hex(typeof value === "string" ? value : String(value));
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

function sanitizeRow(row) {
  const out = {};
  for (const [column, value] of Object.entries(row)) out[column] = sanitizeCell(column, value);
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
  yield JSON.stringify({ kind: "watermark", version: 1, backedUpAt: Date.now(), rooms, events }) + "\n";
  for (const table of exportTableOrder(db)) {
    const columns = tableColumns(db, table);
    if (!columns.length) continue;
    for (const row of exportTableRows(db, table, columns, pageRows)) yield JSON.stringify({ table, row: sanitizeRow(row) }) + "\n";
  }
  yield JSON.stringify(exportTrailer(db)) + "\n";
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
export function exportTrailer(db) {
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
      hash.update(`${sanitizeCell("room_id", row.room_id)}\t${sanitizeCell("sequence", row.sequence)}\t${sanitizeCell("id", row.id)}\n`);
    }
    count += rows.length;
    if (rows.length < TRAILER_PAGE_ROWS) break;
    ({ room_id: roomId, sequence } = rows.at(-1));
  }
  return { kind: "trailer", version: 1, events: count, eventsHash: hash.digest("hex") };
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
function cellOf(value) {
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
function checkStoredBytes(table, row) {
  if (!(row.bytes instanceof Uint8Array)) return;
  if (typeof row.byte_length === "number" && row.bytes.length !== row.byte_length)
    throw new Error(`Export ${table} row ${row.id ?? "?"} bytes do not match its byte_length`);
  if (typeof row.sha256 === "string" && sha256Hex(row.bytes) !== row.sha256)
    throw new Error(`Export ${table} row ${row.id ?? "?"} bytes do not match its sha256`);
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
      if (record.version !== 1 || !Number.isSafeInteger(record.events) || typeof record.eventsHash !== "string" || !/^[0-9a-f]{64}$/.test(record.eventsHash))
        throw new Error("Export trailer is malformed");
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
// restored store starts with fresh budgets. Replay skips these and reports the
// row counts; the export itself still holds the rows.
export const REPLAY_SKIPPED_TABLES = Object.freeze([
  "room_runtime_version", "room_writer_permit",
  "emissary_drops", "emissary_idempotency", "emissary_invite_attribution",
  "emissary_journal", "external_identities", "external_receipts",
  "abuse_rate_buckets"
]);

const CLAIM_PERMIT_TABLE = "public_work_claim_writer_permit";

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
  // write the watermark could not see must never verify.
  const trailerState = trailer ? (verifyTrailer(trailer, byTable), "verified") : "absent";
  const directory = dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(filename)) throw new Error("Refusing to replay into an existing store");
  const store = new RoomStore(filename);
  try {
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
          const cells = Object.fromEntries(keys.map(key => [key, cellOf(row[key])]));
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
    let recovery = null, invitations = {}, auditResult = { ok: true };
    try {
      recovery = auditRecovery(store);
      invitations = store.verifyInvitationAudit();
    } catch (error) {
      if (audit === "strict") throw error;
      auditResult = { ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 200) };
    }
    chmodSync(filename, 0o600);
    return { verified: true, events, trailer: trailerState, ...invitations, recovery, audit: auditResult, skippedTables: skipped };
  } finally { store.close(); }
}
