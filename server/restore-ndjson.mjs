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
  let watermark = null;
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
    if (typeof record?.table !== "string" || !IDENT.test(record.table) || !record.row || typeof record.row !== "object" || Array.isArray(record.row))
      throw new Error("Export line is not a table row");
    // Cloudflare-internal storage tables are the target DO's own business;
    // they are never room data and must not cross between Durable Objects.
    if (record.table.startsWith("_cf_") || RESTORE_SKIP_TABLES.has(record.table)) continue;
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }
  if (!watermark || watermark.version !== 1 || !Number.isSafeInteger(watermark.events))
    throw new Error("Export is missing its watermark");
  return { watermark, byTable };
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
  const { watermark, byTable } = parseNdjsonExport(ndjson);
  const db = store.db;
  if (db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) throw new Error("Refusing to replay into a non-empty store");
  const existing = new Set(tableNames(db));
  const order = insertOrder(new Set(byTable.keys()));
  for (const table of order) if (!existing.has(table)) throw new Error("Export names a table this store does not have");
  // A migrated-but-empty store still holds migration-seeded singleton rows
  // (e.g. the public work-claim writer permit). Clear each replayed table
  // first, exactly like the file-based replay; foreign keys go off for the
  // walk and the foreign_key_check below proves the result (same shape as
  // server/room-export.mjs replayNdjson). Verification runs INSIDE the
  // transaction: any failure rolls the replay back, so a failed restore
  // leaves the store empty and retryable instead of half-restored.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    return store.transaction(() => {
      for (const table of order) db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      for (const table of order) {
        const rows = byTable.get(table);
        // Parents before children, matching the exporter's credentials order.
        if (table === "credentials") rows.sort((a, b) => Number(a.parent_hash != null) - Number(b.parent_hash != null));
        const known = new Set(tableColumns(db, table));
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.some(key => !known.has(key))) throw new Error("Export row does not match the store schema");
          if (!keys.length) continue;
          db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
            .run(...keys.map(key => row[key]));
        }
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
      return { verified: true, events, tables: order.length, backedUpAt: watermark.backedUpAt ?? null, ...audit, recovery };
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
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
    ndjson = await request.text();
  } catch {
    return jsonResponse(400, { error: { code: "unreadable_body", message: "Could not read the restore body" } });
  }
  if (ndjson.length > RESTORE_MAX_BYTES)
    return jsonResponse(413, { error: { code: "too_large", message: "Restore is too large for a single request" } });
  let result;
  try {
    result = replayNdjsonInto(ndjson, store);
  } catch (error) {
    const message = error?.message ?? String(error);
    if (/non-empty/.test(message)) return jsonResponse(409, { error: { code: "restore_refused_nonempty", message: "Restore refuses a store that already holds rooms" } });
    if (/Export (is empty|line is not JSON|is missing its watermark|has more than one watermark|line is not a table row|names a table|row does not match)/.test(message))
      return jsonResponse(422, { error: { code: "invalid_restore", message } });
    if (/watermark does not match|foreign key check/.test(message))
      return jsonResponse(422, { error: { code: "restore_verification_failed", message } });
    return jsonResponse(500, { error: { code: "restore_failed", message: "Restore failed during replay" } });
  }
  return jsonResponse(200, {
    ok: true,
    verified: result.verified,
    events: result.events,
    tables: result.tables,
    backedUpAt: result.backedUpAt ? new Date(result.backedUpAt).toISOString() : null,
    note: "Secrets in the export are hashes, not working credentials: re-issue every agent key, token and secret after a restore, and re-apply any revocations made after the backup.",
  });
}
