// Durable Object export. The on-disk server copies its sqlite file
// (scripts/backup-room.mjs). A Durable Object cannot hand that file out, so
// this streams the same store as NDJSON and replays it into a fresh file.
// The secret columns named in EXPORT_SECRET_COLUMNS, raw token shapes
// inside other cells, and copies of the store's own secret values inside
// content are replaced with salted sha256 placeholders (see
// server/export-scrub.mjs — the one scrub every export shape shares).
// Everything else round-trips verbatim, and every content substitution is
// counted in the trailer's scrubbedCells so a restore reports the loss.
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RoomStore } from "./store.mjs";
import { auditRecovery } from "./recovery.mjs";
import { Buffer } from "node:buffer";
import { createExportScrubContext, defaultExportScrubContext, placeholderFor, registerSecretValues, scrubText, isScrubCountsShape } from "./export-scrub.mjs";
import { hydrateWorkItems } from "./work-repository.mjs";

const IDENT = /^[a-z_][a-z0-9_]*$/;
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
// Policy 3 (audit conversion, export family): salted placeholders that a
// dictionary cannot reverse, the expanded token shapes and value-shaped
// scrub of server/export-scrub.mjs, digest-aware work-item rebinding,
// edited-message current-ification, and scrub counts in the trailer.
// Policy 2 streams carry no legacy-hashed columns either (the #3599 set
// replaced the name regex), so only a MISSING marker means legacy.
export const BACKUP_SANITIZE_POLICY = 3;
export const isLegacySanitizeWatermark = watermark => watermark?.sanitizePolicy === undefined;

export function sanitizeCell(table, column, value, context = defaultExportScrubContext()) {
  if (value === null || value === undefined) return null;
  if (isExportSecretColumn(table, column)) return placeholderFor(typeof value === "string" ? value : String(value), context);
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
  return scrubText(value, context, table, column);
}

function sanitizeRow(table, row, context) {
  const out = {};
  for (const [column, value] of Object.entries(row)) out[column] = sanitizeCell(table, column, value, context);
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

// ---------------------------------------------------------------------------
// Export context pre-scans (audit conversion, export family). One pass over
// the store's own facts, taken before the first row is yielded, so the
// per-cell scrub below is value-shaped and digest-aware instead of a bare
// regex over each cell in isolation:
// - secretValues: the actual values sitting in EXPORT_SECRET_COLUMNS
//   cells. A copy of one inside ordinary content (a credential pasted
//   into a message) is scrubbed wherever it appears (B7-4 F3).
// - workDigests: work_entities bodies are digest-bound — the rooms
//   projection references each item by the sha256 of its body and
//   hydrateWorkItems refuses a mismatch. Scrubbing a body without
//   rebinding its digest made the export strict-unrestorable and its
//   report-mode restore unreadable (B7-4 F1). The rebind map carries
//   each scrubbed body and the digest OF THE SCRUBBED BODY, and the
//   rooms-projection transform below rewrites the references to match.
// - messageCurrents: each message's current body (null when deleted).
//   Edited-away text otherwise survives in the event log, the stored
//   projection and reducer extras and restores live (B7-4 F5); the
//   transforms below current-ify those copies before scrubbing, the
//   export-side leg of the write-time control deletes already have.
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function prepareExportContext(db) {
  const context = createExportScrubContext();
  for (const [table, columns] of Object.entries(EXPORT_SECRET_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const present = new Set(tableColumns(db, table));
    for (const column of columns) {
      if (!present.has(column)) continue;
      const values = db.prepare(`SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)}`).all().map(row => row.v);
      registerSecretValues(context, values);
    }
  }
  const workDigests = new Map();
  if (tableExists(db, "work_entities")) {
    for (const row of db.prepare("SELECT room_id, work_id, body FROM work_entities").all()) {
      if (typeof row.body !== "string") continue;
      const scrubbed = scrubText(row.body, context, "work_entities", "body");
      if (scrubbed !== row.body) workDigests.set(`${row.room_id}\0${row.work_id}`, { body: scrubbed, digest: sha256Hex(scrubbed) });
    }
  }
  const messageCurrents = new Map();
  if (tableExists(db, "messages")) {
    for (const row of db.prepare("SELECT room_id, message_id, body, deleted_at FROM messages").all()) {
      messageCurrents.set(`${row.room_id}\0${row.message_id}`, row.deleted_at ? null : (typeof row.body === "string" ? row.body : null));
    }
  }
  return { context, workDigests, messageCurrents };
}

const MESSAGE_EVENT_TYPES = new Set(["message.posted", "message.edited"]);
function eventMessageId(entry) {
  const data = entry?.data;
  if (!data || typeof data !== "object") return null;
  if (typeof data.messageId === "string") return data.messageId;
  if (entry.type === "message.posted" && typeof entry.id === "string") return entry.id;
  return null;
}

// One parsed event object, current-ified: a posted/edited event whose
// message has since been edited (or deleted) carries the CURRENT body,
// never the superseded text it was appended with.
function currentifyEvent(entry, roomId, messageCurrents) {
  if (!entry || typeof entry !== "object" || !MESSAGE_EVENT_TYPES.has(entry.type)) return entry;
  const messageId = eventMessageId(entry);
  if (messageId === null || !entry.data || typeof entry.data !== "object" || !Object.hasOwn(entry.data, "body")) return entry;
  const key = `${roomId}\0${messageId}`;
  if (!messageCurrents.has(key)) return entry;
  const current = messageCurrents.get(key);
  if (entry.data.body === current) return entry;
  return { ...entry, data: { ...entry.data, body: current } };
}

function currentifyHistory(entries, roomId, messageCurrents) {
  if (!Array.isArray(entries)) return entries;
  let changed = false;
  const next = entries.map(entry => {
    const current = currentifyEvent(entry, roomId, messageCurrents);
    if (current !== entry) changed = true;
    return current;
  });
  return changed ? next : entries;
}

// Edit-history entries carry each superseded body; current-ify every
// entry to the message's current body so no earlier text survives.
function currentifyEditHistory(message, roomId, messageCurrents) {
  if (!message || typeof message !== "object" || !Array.isArray(message.editHistory)) return message;
  const key = `${roomId}\0${message.id}`;
  const current = messageCurrents.has(key) ? messageCurrents.get(key)
    : (typeof message.body === "string" ? message.body : null);
  let changed = false;
  const editHistory = message.editHistory.map(entry => {
    if (!entry || typeof entry !== "object" || entry.body === current) return entry;
    changed = true;
    return { ...entry, body: current };
  });
  return changed ? { ...message, editHistory } : message;
}

function transformExportRow(table, row, prepared) {
  const { workDigests, messageCurrents } = prepared;
  if (table === "work_entities") {
    const rebind = workDigests.get(`${row.room_id}\0${row.work_id}`);
    return rebind ? { ...row, body: rebind.body, digest: rebind.digest } : row;
  }
  if (table === "events" && typeof row.body === "string") {
    try {
      const entry = JSON.parse(row.body);
      const current = currentifyEvent(entry, row.room_id, messageCurrents);
      return current === entry ? row : { ...row, body: JSON.stringify(current) };
    } catch { return row; }
  }
  if (table === "messages" && typeof row.reducer_extras_json === "string") {
    try {
      const extras = JSON.parse(row.reducer_extras_json);
      if (!extras || typeof extras !== "object" || !Array.isArray(extras.editHistory)) return row;
      const current = row.deleted_at ? null : (typeof row.body === "string" ? row.body : null);
      let changed = false;
      const editHistory = extras.editHistory.map(entry => {
        if (!entry || typeof entry !== "object" || entry.body === current) return entry;
        changed = true;
        return { ...entry, body: current };
      });
      return changed ? { ...row, reducer_extras_json: JSON.stringify({ ...extras, editHistory }) } : row;
    } catch { return row; }
  }
  if (table === "rooms" && typeof row.projection === "string") {
    try {
      const state = JSON.parse(row.projection);
      if (!state || typeof state !== "object") return row;
      let next = state;
      if (Array.isArray(next.messages)) {
        const messages = next.messages.map(message => currentifyEditHistory(message, row.id, messageCurrents));
        if (messages.some((message, index) => message !== next.messages[index])) next = { ...next, messages };
      }
      if (Array.isArray(next.eventLog)) {
        const eventLog = currentifyHistory(next.eventLog, row.id, messageCurrents);
        if (eventLog !== next.eventLog) next = { ...next, eventLog };
      }
      if (next.workItems && typeof next.workItems === "object") {
        let changed = false;
        const workItems = {};
        for (const [id, value] of Object.entries(next.workItems)) {
          const rebind = value && typeof value === "object" && value._workEntity === 1
            ? workDigests.get(`${row.id}\0${id}`) : null;
          if (rebind && value.digest !== rebind.digest) { workItems[id] = { ...value, digest: rebind.digest }; changed = true; }
          else workItems[id] = value;
        }
        if (changed) next = { ...next, workItems };
      }
      return next === state ? row : { ...row, projection: JSON.stringify(next) };
    } catch { return row; }
  }
  return row;
}

export function* exportNdjsonLines(db, { pageRows = EXPORT_PAGE_ROWS } = {}) {
  const prepared = prepareExportContext(db);
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
      const sanitized = sanitizeRow(table, transformExportRow(table, row, prepared), prepared.context);
      digests.add(table, sanitized);
      yield JSON.stringify({ table, row: sanitized }) + "\n";
    }
  }
  const trailer = exportTrailer(db, digests.finish());
  // B2-5-F1: the trailer carries the export's content-scrub counts, so
  // every restore path can surface the substitutions it lands instead of
  // reporting a silently rewritten round trip as lossless.
  const scrubbedCells = prepared.context.report();
  if (Object.keys(scrubbedCells).length) trailer.scrubbedCells = scrubbedCells;
  yield JSON.stringify(trailer) + "\n";
}

// The trailer's content-scrub counts, for restore results. Exports
// written before the counts existed report an empty map, never a guess.
export function scrubbedCellsOf(trailer) {
  return trailer && isScrubCountsShape(trailer.scrubbedCells) ? trailer.scrubbedCells : {};
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
  if (record.scrubbedCells !== undefined && !isScrubCountsShape(record.scrubbedCells)) throw malformed();
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
// - Legacy streams (watermark with no sanitizePolicy marker, written by the
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
  "abuse_rate_buckets", "agent_wake_counters", "agent_wake_failures"
]);

const CLAIM_PERMIT_TABLE = "public_work_claim_writer_permit";

// #3325: tables excluded from the trailer's content digests (see
// createTableDigests above): exactly the tables no restore path loads.
export const CONTENT_DIGEST_SKIPPED_TABLES = Object.freeze([...REPLAY_SKIPPED_TABLES, CLAIM_PERMIT_TABLE]);

// Readability probe for a restored store (audit conversion, export
// family — the headline acceptance): every restored room is read back
// through the store's own read path. A room that throws on read (the
// work_projection_corrupt class) must never be certified verified/full
// by a report-mode restore: the caller downgrades the result instead.
// Returns one {room, error} entry per unreadable room.
export function probeRestoredReadability(store) {
  const unreadable = [];
  let roomIds = [];
  try { roomIds = store.db.prepare("SELECT id FROM rooms ORDER BY id").all().map(row => row.id); }
  catch { return unreadable; }
  for (const roomId of roomIds) {
    try {
      if (typeof store.room === "function") store.room(roomId);
      else {
        const row = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
        if (row) hydrateWorkItems(store.db, roomId, JSON.parse(row.projection));
      }
    } catch (error) {
      unreadable.push({ room: roomId, error: String(error?.message ?? error).split("\n")[0].slice(0, 200) });
    }
  }
  return unreadable;
}

// Replay into a new sqlite file, then run the same checks as backupRoom.
// audit "strict" (default) refuses a store the recovery audit rejects.
// audit "report" still requires the row load, foreign keys, quick_check,
// file bytes and the event count to match, but returns an audit failure
// instead of throwing: the recovery audit replays every room with the
// current reducer, and production rooms written by older code can differ
// from that replay while the live room serves them fine. A disaster
// restore needs the data back and the drift named, not a refusal.
export function replayNdjson(ndjson, filename, { audit = "strict", retainTables = null } = {}) {
  if (audit !== "strict" && audit !== "report") throw new Error("audit must be strict or report");
  if (retainTables != null && typeof retainTables !== "function") throw new Error("retainTables must be a function");
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
    const tracker = createSanitizedCellTracker(store.db, { legacySanitize: isLegacySanitizeWatermark(watermark) });
    // A room restore passes the tables it is willing to load. Names outside
    // that set fail the check below, including directory tables and unknown
    // tables. The default restore sees every table the fresh store created.
    const retained = retainTables ? retainTables(store.db) : null;
    if (retained != null && !(retained instanceof Set)) throw new Error("retainTables must return the tables this store keeps");
    const existing = retained ?? new Set(tableNames(store.db));
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
    // Headline acceptance: a report-mode restore must not certify
    // verified/"full" over a room that throws on read. The data still
    // lands (report mode is the operator's opt-in), but the verdict is
    // downgraded and the unreadable rooms are named.
    const unreadable = probeRestoredReadability(store);
    if (unreadable.length && audit === "strict") throw new Error(unreadable[0].error);
    chmodSync(filename, 0o600);
    const downgraded = unreadable.length > 0;
    return { verified: !downgraded, events, trailer: trailerState, contentVerification: downgraded ? "unreadable" : contentVerification, ...invitations, recovery, audit: auditResult, skippedTables: skipped, sanitizedCells: tracker.report(), scrubbedCells: scrubbedCellsOf(trailer), readability: { ok: !downgraded, unreadable } };
  } finally { store.close(); }
}
