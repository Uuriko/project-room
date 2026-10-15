// Whole-store NDJSON restore into an already-open store.
//
// Sibling of server/room-export.mjs (which owns the export format). The export
// module's replayNdjson targets a fresh sqlite *file* (node-only). A Durable
// Object cannot accept a sqlite file, so disaster recovery on Cloudflare needs
// this: replay the NDJSON export through the store's own db handle, which on
// the worker is the DurableDatabase adapter over ctx.storage.sql and on node
// is the node:sqlite handle. The parse below mirrors room-export.mjs and is
// kept in this module on purpose: restore must not depend on the file-
// packaging path, and it must not collide with in-flight export changes.
//
// What a restore is and is not:
// - The export hashes every secret column (see room-export.mjs sanitizeRow),
//   so a restore recovers data, never working credentials. Every agent key,
//   token and secret must be re-issued after a restore.
// - Restore is fail-closed: it replays only into a store whose rooms table is
//   empty. It never overwrites a live room.
// - A restore resurrects authority exactly as it was at backup time. Anything
//   revoked between the backup and the loss must be re-applied by the operator
//   (docs/BACKUP-DR.md); there is no "current" store left to reconcile against.
import { createHash, timingSafeEqual } from "node:crypto";
import { auditRecovery } from "./recovery.mjs";
import { cellOf, checkStoredBytes, verifyTrailer, assertTrailerShape, createTableDigests, contentVerificationLevel, REPLAY_SKIPPED_TABLES } from "./room-export.mjs";
import { verifyPublicWorkClaimFence } from "./public-work-claim-fence.mjs";
import { BACKUP_MANIFEST_VERSION, backupObjectKey, backupPartKey } from "../cloudflare/room-backup.mjs";

const IDENT = /^[a-z_][a-z0-9_]*$/;
// Parent-first table order, mirroring the exporter's FIRST list in
// server/room-export.mjs so foreign keys resolve during the insert walk.
const FIRST = ["accounts", "rooms", "events", "commands", "member_accounts", "account_access_events", "credentials",
  "account_credentials", "account_session_slots", "cursors", "projection_checkpoints"];
// Durable Object migration state. A DO export carries these tables, but the
// restore target's own migrated schema is authoritative: replaying the
// export's version marker could downgrade the writer fence and brick the DO.
// (On node the schema version lives in PRAGMA user_version, so these tables
// only ever appear in DO-produced exports.)
const RESTORE_SKIP_TABLES = new Set(["room_runtime_version", "room_writer_permit"]);
// #3324: the public work-claim writer permit is the TARGET's own authority,
// never the export's. The file replay drops the exported row and opens the
// target's seeded permit for the bulk load; an imported enabled=1 row would
// restore "verified" with the claim fence open and brick the store at its
// next open (the fence must be closed at rest).
const CLAIM_PERMIT_TABLE = "public_work_claim_writer_permit";

export const RESTORE_MAX_BYTES = 64 * 1024 * 1024;

function quoteIdent(name) {
  if (!IDENT.test(name)) throw new Error("Restore names a table or column this store will not write");
  return `"${name}"`;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => row.name).filter(name => IDENT.test(name));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(column => column.name);
}

export function parseNdjsonExport(ndjson) {
  if (typeof ndjson !== "string" || !ndjson.trim()) throw new Error("Export is empty");
  const byTable = new Map();
  const skippedTables = {};
  const digests = createTableDigests();
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
    // End-of-stream integrity trailer (server/room-export.mjs exportTrailer).
    if (record?.kind === "trailer") {
      if (trailer) throw new Error("Export has more than one trailer");
      assertTrailerShape(record);
      trailer = record;
      continue;
    }
    if (typeof record?.table !== "string" || !IDENT.test(record.table) || !record.row || typeof record.row !== "object" || Array.isArray(record.row))
      throw new Error("Export line is not a table row");
    // #3325: digest every loadable row as parsed, before the skip branch
    // below decides what lands — the digest set and the skip set are
    // disjoint by construction (CONTENT_DIGEST_SKIPPED_TABLES).
    digests.add(record.table, record.row);
    // Cloudflare-internal storage tables are the target DO's own business;
    // they are never room data and must not cross between Durable Objects.
    // Skipped rows are counted and reported, never silently dropped (#3325).
    if (record.table.startsWith("_cf_") || RESTORE_SKIP_TABLES.has(record.table)
      || record.table === CLAIM_PERMIT_TABLE || REPLAY_SKIPPED_TABLES.includes(record.table)) {
      skippedTables[record.table] = (skippedTables[record.table] ?? 0) + 1;
      continue;
    }
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }
  if (!watermark || watermark.version !== 1 || !Number.isSafeInteger(watermark.events))
    throw new Error("Export is missing its watermark");
  return { watermark, byTable, trailer, skippedTables, tableDigests: digests.finish() };
}

function insertOrder(names) {
  const ordered = FIRST.filter(table => names.has(table));
  for (const table of [...names].sort()) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

// Replay a whole-store NDJSON export into an open store. The store must be
// empty (no rooms row); a non-empty store is refused, never overwritten.
export function replayNdjsonInto(ndjson, store) {
  if (!store?.db) throw new Error("Restore needs an open store");
  const { watermark, byTable, trailer, skippedTables, tableDigests } = parseNdjsonExport(ndjson);
  // Torn export (a write landed mid-stream): refuse before touching the store.
  if (trailer) verifyTrailer(trailer, byTable);
  // #3325: a tampered non-event row must refuse just as early.
  const contentVerification = contentVerificationLevel(trailer, tableDigests);
  const db = store.db;
  if (db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) throw new Error("Refusing to replay into a non-empty store");
  const existing = new Set(tableNames(db));
  const order = insertOrder(new Set(byTable.keys()));
  for (const table of order) if (!existing.has(table)) throw new Error("Export names a table this store does not have");
  // A migrated-but-empty store still holds migration-seeded singleton rows.
  // Clear each replayed table first, exactly like the file-based replay;
  // foreign keys go off for the walk and the foreign_key_check below proves
  // the result (same shape as server/room-export.mjs replayNdjson).
  // Verification runs INSIDE the transaction: any failure rolls the replay
  // back, so a failed restore leaves the store empty and retryable instead
  // of half-restored.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    return store.transaction(() => {
      for (const table of order) db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      // #3324: the claim fence aborts any write to a public namespace's
      // claims unless the permit is open. Mirror the file replay: open the
      // TARGET's own seeded permit for the bulk load (the exported permit
      // row is never loaded — parseNdjsonExport skips it), close it before
      // verification, and prove closed-at-rest below.
      const claimPermit = existing.has(CLAIM_PERMIT_TABLE);
      if (claimPermit) db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=1 WHERE singleton=1`).run();
      for (const table of order) {
        const rows = byTable.get(table);
        // Parents before children, matching the exporter's credentials order.
        if (table === "credentials") rows.sort((a, b) => Number(a.parent_hash != null) - Number(b.parent_hash != null));
        const known = new Set(tableColumns(db, table));
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.some(key => !known.has(key))) throw new Error("Export row does not match the store schema");
          if (!keys.length) continue;
          // Binary cells leave the exporter as {$base64}; decode and prove them.
          const cells = Object.fromEntries(keys.map(key => [key, cellOf(row[key])]));
          checkStoredBytes(table, cells);
          db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
            .run(...keys.map(key => cells[key]));
        }
      }
      if (claimPermit) {
        db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=0 WHERE singleton=1`).run();
        verifyPublicWorkClaimFence(db);
      }
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored store failed foreign key check");
      const events = db.prepare("SELECT count(*) AS n FROM events").get().n;
      if (events !== watermark.events) throw new Error("Export watermark does not match the restored event log");
      // Exports written with per-table watermark counts (newer exporters)
      // verify every table, not just the event log; older exports skip this.
      if (watermark.tables && typeof watermark.tables === "object") {
        for (const [table, expected] of Object.entries(watermark.tables)) {
          const actual = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n;
          if (actual !== expected) throw new Error(`Export watermark does not match the restored table ${table}: expected ${expected} rows, got ${actual}`);
        }
      }
      const recovery = auditRecovery(store);
      const audit = store.verifyInvitationAudit();
      return { verified: true, trailer: trailer ? "verified" : "absent", contentVerification, events, tables: order.length, backedUpAt: watermark.backedUpAt ?? null, skippedTables, ...audit, recovery };
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

// ---------------------------------------------------------------------------
// #3409: the request-body restore above caps at RESTORE_MAX_BYTES because it
// buffers the whole export, and production's daily backup is past that cap —
// so the only DO-native restore path refused the current backup outright.
// The backup already lives in KV as a manifest plus bounded parts (written
// by cloudflare/room-backup.mjs). This session replays it from there: parts
// are fetched and verified one at a time and fed line by line, so peak
// memory is one part plus one line plus the event tuples the trailer check
// needs — the total size is unbounded. Room transactions must stay
// synchronous, so inserts commit in bounded batches; any failure runs
// abort(), which deletes every table the replay touched (the target was
// verified empty first), leaving the store empty and retryable.
const REPLAY_BATCH_ROWS = 500;
const REPLAY_BATCH_BYTES = 4 * 1024 * 1024;

export function createBackupReplaySession(store) {
  if (!store?.db) throw new Error("Restore needs an open store");
  const db = store.db;
  if (db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) throw new Error("Refusing to replay into a non-empty store");
  const existing = new Set(tableNames(db));
  const claimPermit = existing.has(CLAIM_PERMIT_TABLE);
  const skippedTables = {};
  const eventTuples = [];
  const digests = createTableDigests();
  const counts = new Map();
  const knownColumns = new Map();
  const buffers = new Map();
  const bufferBytes = new Map();
  const cleared = new Set();
  let watermark = null;
  let trailer = null;
  let carry = "";
  let settled = false;

  db.exec("PRAGMA foreign_keys=OFF");
  // #3324, as in replayNdjsonInto: open the target's own permit for the
  // load; the exported permit row is skipped in writeLine and never lands.
  if (claimPermit) db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=1 WHERE singleton=1`).run();

  const columnsOf = table => {
    if (!knownColumns.has(table)) knownColumns.set(table, new Set(tableColumns(db, table)));
    return knownColumns.get(table);
  };

  function insertBuffered(table) {
    const rows = buffers.get(table);
    if (!rows?.length) return;
    bufferBytes.set(table, 0);
    store.transaction(() => {
      if (!cleared.has(table)) {
        db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
        cleared.add(table);
      }
      const known = columnsOf(table);
      for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.some(key => !known.has(key))) throw new Error("Export row does not match the store schema");
        if (!keys.length) continue;
        const cells = Object.fromEntries(keys.map(key => [key, cellOf(row[key])]));
        checkStoredBytes(table, cells);
        db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
          .run(...keys.map(key => cells[key]));
      }
    });
    buffers.set(table, []);
  }

  function writeLine(line) {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error("Export line is not JSON"); }
    if (record?.kind === "watermark") {
      if (watermark) throw new Error("Export has more than one watermark");
      watermark = record;
      return;
    }
    if (record?.kind === "trailer") {
      if (trailer) throw new Error("Export has more than one trailer");
      assertTrailerShape(record);
      trailer = record;
      return;
    }
    if (typeof record?.table !== "string" || !IDENT.test(record.table) || !record.row || typeof record.row !== "object" || Array.isArray(record.row))
      throw new Error("Export line is not a table row");
    // #3325: digest each loadable row as it streams past, before the skip
    // branch — finish() pins the whole stream against the trailer.
    digests.add(record.table, record.row);
    if (record.table.startsWith("_cf_") || RESTORE_SKIP_TABLES.has(record.table)
      || record.table === CLAIM_PERMIT_TABLE || REPLAY_SKIPPED_TABLES.includes(record.table)) {
      skippedTables[record.table] = (skippedTables[record.table] ?? 0) + 1;
      return;
    }
    if (!existing.has(record.table)) throw new Error("Export names a table this store does not have");
    const keys = Object.keys(record.row);
    if (keys.some(key => !columnsOf(record.table).has(key))) throw new Error("Export row does not match the store schema");
    if (record.table === "events") eventTuples.push({ room_id: record.row.room_id, sequence: record.row.sequence, id: record.row.id });
    counts.set(record.table, (counts.get(record.table) ?? 0) + 1);
    const buffer = buffers.get(record.table) ?? [];
    buffer.push(record.row);
    buffers.set(record.table, buffer);
    // Flush on rows OR bytes: 500 small rows and one 1 MiB attachment row
    // must both stay bounded, so peak memory tracks the batch, not the
    // table's row shape.
    const bytes = (bufferBytes.get(record.table) ?? 0) + line.length;
    bufferBytes.set(record.table, bytes);
    if (buffer.length >= REPLAY_BATCH_ROWS || bytes >= REPLAY_BATCH_BYTES) insertBuffered(record.table);
  }

  function writeText(text) {
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop();
    for (const line of lines) writeLine(line);
  }

  function abort() {
    if (settled) return;
    settled = true;
    try {
      store.transaction(() => {
        for (const table of cleared) db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      });
    } catch { /* the store was verified empty before the replay; a failed cleanup is reported by the caller */ }
    try {
      if (claimPermit) db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=0 WHERE singleton=1`).run();
    } catch { /* closing the permit must not mask the original failure */ }
    db.exec("PRAGMA foreign_keys=ON");
  }

  function finish() {
    try {
      if (carry) { writeLine(carry); carry = ""; }
      if (!watermark || watermark.version !== 1 || !Number.isSafeInteger(watermark.events))
        throw new Error("Export is missing its watermark");
      for (const table of [...buffers.keys()]) insertBuffered(table);
      // Torn export (a write landed mid-stream): refuse, as the buffered
      // replay does — the tuples collected line by line are exactly the
      // rows verifyTrailer hashes.
      if (trailer) verifyTrailer(trailer, new Map([["events", eventTuples]]));
      // #3325: the trailer's table digests pin the non-event rows the same
      // way; a mismatch aborts and wipes the replay like any other failure.
      const contentVerification = contentVerificationLevel(trailer, digests.finish());
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored store failed foreign key check");
      const events = db.prepare("SELECT count(*) AS n FROM events").get().n;
      if (events !== watermark.events) throw new Error("Export watermark does not match the restored event log");
      if (watermark.tables && typeof watermark.tables === "object") {
        for (const [table, expected] of Object.entries(watermark.tables)) {
          const actual = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n;
          if (actual !== expected) throw new Error(`Export watermark does not match the restored table ${table}: expected ${expected} rows, got ${actual}`);
        }
      }
      if (claimPermit) {
        db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=0 WHERE singleton=1`).run();
        verifyPublicWorkClaimFence(db);
      }
      const recovery = auditRecovery(store);
      const audit = store.verifyInvitationAudit();
      settled = true;
      db.exec("PRAGMA foreign_keys=ON");
      return { verified: true, trailer: trailer ? "verified" : "absent", contentVerification, events, tables: counts.size, backedUpAt: watermark.backedUpAt ?? null, skippedTables, ...audit, recovery };
    } catch (error) {
      abort();
      throw error;
    }
  }

  return { writeLine, writeText, finish, abort };
}

// Operator gate, mirroring server/room-export.mjs's operatorExportResponse:
// the same ROOM_BACKUP_TOKEN guards export and restore, and an unconfigured
// token answers 404 so the endpoint does not advertise itself.
const sha256Hex = value => createHash("sha256").update(value).digest("hex");

function authorizeOperatorRestore(authorization, expected) {
  if (typeof expected !== "string" || expected.length < 16) return "unconfigured";
  const match = /^Bearer ([^\s]+)$/i.exec(typeof authorization === "string" ? authorization : "");
  const presented = match?.[1] ?? "";
  const actual = sha256Hex(presented);
  const wanted = sha256Hex(expected);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(wanted)) ? "ok" : "denied";
}

// UTF-8 byte length of a decoded string, stopping once `limit` is exceeded.
// String.length counts UTF-16 code units, not bytes: multibyte characters
// pass a length check while carrying several times the byte cap (#2949), so
// the restore cap must never be measured in string characters.
function utf8ByteLengthExceeds(text, limit) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) return true;
  }
  return false;
}

// Read the request body under RESTORE_MAX_BYTES, measured in bytes.
// When the body is a stream, count each chunk as it arrives and cancel as
// soon as the cap is exceeded, so an oversized chunked body (no
// Content-Length for the pre-read guard) is never buffered in full.
// Bodies without a stream (e.g. test doubles exposing only text()) fall back
// to a byte-accurate check on the decoded string.
async function readRestoreBody(request) {
  if (request.body && typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESTORE_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* already errored/closed */ }
        return { tooLarge: true, text: "" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { tooLarge: false, text: new TextDecoder().decode(bytes) };
  }
  const text = await request.text();
  return { tooLarge: utf8ByteLengthExceeds(text, RESTORE_MAX_BYTES), text };
}

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// POST /api/operator/restore — replay a whole-store NDJSON export into this
// Durable Object's storage. Fail-closed: 404 when the operator token is not
// configured, 401 on a bad token, 405 on non-POST, 409 when the store already
// holds rooms, 413 over the body cap, 422 on a malformed export.
export async function operatorRestoreResponse(request, token, store) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/operator/restore") return null;
  const auth = authorizeOperatorRestore(request.headers.get("authorization"), token);
  if (auth === "unconfigured") return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return jsonResponse(405, { error: { code: "method_not_allowed", message: "Use POST" } });
  if (auth === "denied") return jsonResponse(401, { error: { code: "unauthorized", message: "Operator token required" } });
  if (!store) return jsonResponse(503, { error: { code: "unavailable", message: "Restore unavailable" } });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESTORE_MAX_BYTES)
    return jsonResponse(413, { error: { code: "too_large", message: "Restore is too large for a single request" } });
  let ndjson;
  try {
    const body = await readRestoreBody(request);
    if (body.tooLarge)
      return jsonResponse(413, { error: { code: "too_large", message: "Restore is too large for a single request" } });
    ndjson = body.text;
  } catch {
    return jsonResponse(400, { error: { code: "unreadable_body", message: "Could not read the restore body" } });
  }
  let result;
  try {
    result = replayNdjsonInto(ndjson, store);
  } catch (error) {
    const message = error?.message ?? String(error);
    if (/non-empty/.test(message)) return jsonResponse(409, { error: { code: "restore_refused_nonempty", message: "Restore refuses a store that already holds rooms" } });
    if (/Export (is empty|line is not JSON|is missing its watermark|has more than one watermark|line is not a table row|has more than one trailer|trailer is malformed|BLOB cell|cell is an object|bytes do not match|names a table|row does not match)/.test(message))
      return jsonResponse(422, { error: { code: "invalid_restore", message } });
    if (/watermark does not match|torn|foreign key check|table digest does not match|trailer pins|does not pin/.test(message))
      return jsonResponse(422, { error: { code: "restore_verification_failed", message } });
    return jsonResponse(500, { error: { code: "restore_failed", message: "Restore failed during replay" } });
  }
  return jsonResponse(200, {
    ok: true,
    verified: result.verified,
    contentVerification: result.contentVerification,
    events: result.events,
    tables: result.tables,
    backedUpAt: result.backedUpAt ? new Date(result.backedUpAt).toISOString() : null,
    note: "Secrets in the export are hashes, not working credentials: re-issue every agent key, token and secret after a restore, and re-apply any revocations made after the backup.",
  });
}

const RESTORE_NOTE = "Secrets in the export are hashes, not working credentials: re-issue every agent key, token and secret after a restore, and re-apply any revocations made after the backup.";
const BACKUP_KEY_PATTERN = /^room-backups\/\d{4}-\d{2}-\d{2}\.ndjson$/;

function kvBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

// POST /api/operator/restore-from-backup — restore the daily backup that is
// already stored in the ROOM_BACKUPS_KV namespace (the production backup
// target), without moving it through a request body: #3409's cap does not
// apply because nothing larger than one backup part is ever held. Same
// operator token and fail-closed posture as /api/operator/restore: 404 when
// the token is unconfigured, 401 on a bad token, 404 when the named backup
// does not exist, 409 on a non-empty store, 422 on a malformed or
// unverifiable backup. The optional JSON body names the backup:
// { "key": "room-backups/2026-10-14.ndjson" } (default: today's key).
export async function operatorRestoreFromBackupResponse(request, token, store, kv) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/operator/restore-from-backup") return null;
  const auth = authorizeOperatorRestore(request.headers.get("authorization"), token);
  if (auth === "unconfigured") return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return jsonResponse(405, { error: { code: "method_not_allowed", message: "Use POST" } });
  if (auth === "denied") return jsonResponse(401, { error: { code: "unauthorized", message: "Operator token required" } });
  if (!store) return jsonResponse(503, { error: { code: "unavailable", message: "Restore unavailable" } });
  if (!kv || typeof kv.get !== "function")
    return jsonResponse(503, { error: { code: "backup_unavailable", message: "No backup namespace is configured on this deployment" } });
  let key = url.searchParams.get("key");
  try {
    const text = await request.text();
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.key === "string") key = parsed.key;
    }
  } catch {
    return jsonResponse(400, { error: { code: "unreadable_body", message: "Could not read the restore body" } });
  }
  if (key == null) key = backupObjectKey(new Date());
  if (!BACKUP_KEY_PATTERN.test(key))
    return jsonResponse(422, { error: { code: "invalid_restore", message: "Backup key is not a daily backup key" } });
  const manifestBytes = kvBytes(await kv.get(key));
  if (!manifestBytes) return jsonResponse(404, { error: { code: "backup_not_found", message: "No backup is stored under that key" } });
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); }
  catch { return jsonResponse(422, { error: { code: "invalid_restore", message: "Backup manifest is not JSON" } }); }
  const partsValid = manifest?.kind === "room-backup-manifest"
    && Number(manifest?.version) >= BACKUP_MANIFEST_VERSION
    && Array.isArray(manifest?.parts) && manifest.parts.length > 0
    && manifest.parts.every((part, index) => part?.key === backupPartKey(key, index)
      && Number.isSafeInteger(part?.bytes) && part.bytes > 0
      && typeof part?.sha256 === "string" && /^[0-9a-f]{64}$/.test(part.sha256))
    && Number.isSafeInteger(manifest?.bytes)
    && manifest.parts.reduce((sum, part) => sum + part.bytes, 0) === manifest.bytes
    && typeof manifest?.sha256 === "string" && /^[0-9a-f]{64}$/.test(manifest.sha256);
  if (!partsValid) return jsonResponse(422, { error: { code: "invalid_restore", message: "Backup manifest is malformed" } });

  let session;
  try {
    session = createBackupReplaySession(store);
  } catch (error) {
    const message = error?.message ?? String(error);
    if (/non-empty/.test(message)) return jsonResponse(409, { error: { code: "restore_refused_nonempty", message: "Restore refuses a store that already holds rooms" } });
    return jsonResponse(500, { error: { code: "restore_failed", message: "Restore failed before replay" } });
  }
  const whole = createHash("sha256");
  const decoder = new TextDecoder();
  let total = 0;
  try {
    for (const part of manifest.parts) {
      const bytes = kvBytes(await kv.get(part.key, "arrayBuffer")) ?? kvBytes(await kv.get(part.key));
      if (!bytes) throw new Error(`Backup part ${part.key} is missing`);
      if (bytes.byteLength !== part.bytes || createHash("sha256").update(bytes).digest("hex") !== part.sha256)
        throw new Error(`Backup part ${part.key} does not match its manifest entry`);
      whole.update(bytes);
      total += bytes.byteLength;
      session.writeText(decoder.decode(bytes, { stream: true }));
    }
    session.writeText(decoder.decode());
    if (total !== manifest.bytes || whole.digest("hex") !== manifest.sha256)
      throw new Error("Backup does not match its manifest sha256");
    const result = session.finish();
    return jsonResponse(200, {
      ok: true,
      verified: result.verified,
      contentVerification: result.contentVerification,
      events: result.events,
      tables: result.tables,
      backedUpAt: result.backedUpAt ? new Date(result.backedUpAt).toISOString() : null,
      source: "kv-backup",
      key,
      bytes: total,
      skippedTables: result.skippedTables,
      note: RESTORE_NOTE,
    });
  } catch (error) {
    try { session.abort(); } catch { /* abort is best-effort; the original error is the report */ }
    const message = error?.message ?? String(error);
    if (/Export (is empty|line is not JSON|is missing its watermark|has more than one watermark|line is not a table row|has more than one trailer|trailer is malformed|BLOB cell|cell is an object|bytes do not match|names a table|row does not match)/.test(message))
      return jsonResponse(422, { error: { code: "invalid_restore", message } });
    if (/watermark does not match|torn|foreign key check|table digest does not match|trailer pins|does not pin|Backup (part|does not match)/.test(message))
      return jsonResponse(422, { error: { code: "restore_verification_failed", message } });
    return jsonResponse(500, { error: { code: "restore_failed", message: "Restore failed during replay" } });
  }
}
