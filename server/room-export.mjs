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

function sanitizeCell(column, value) {
  if (value === null || value === undefined) return null;
  if (secretColumn(column)) return sha256Hex(typeof value === "string" ? value : String(value));
  // REL-14: BLOB cells (room file bytes) leave as base64. JSON.stringify of a
  // Uint8Array is an object of indices that replay could not bind, so any room
  // holding a file produced an export that could not be restored.
  if (value instanceof Uint8Array) return { $base64: Buffer.from(value).toString("base64") };
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

export function* exportNdjsonLines(db) {
  const rooms = db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
  const events = db.prepare("SELECT count(*) AS n FROM events").get().n;
  yield JSON.stringify({ kind: "watermark", version: 1, backedUpAt: Date.now(), rooms, events }) + "\n";
  for (const table of exportTableOrder(db)) {
    const columns = tableColumns(db, table);
    if (!columns.length) continue;
    const order = table === "credentials" && columns.includes("parent_hash") ? " ORDER BY parent_hash IS NOT NULL, hash" : "";
    const sql = `SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}${order}`;
    for (const row of db.prepare(sql).all()) yield JSON.stringify({ table, row: sanitizeRow(row) }) + "\n";
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
    if (typeof record?.table !== "string" || !record.row || typeof record.row !== "object" || Array.isArray(record.row)) throw new Error("Export line is not a table row");
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }
  if (!watermark || watermark.version !== 1 || !Number.isSafeInteger(watermark.events)) throw new Error("Export is missing its watermark");
  return { watermark, byTable };
}

function insertOrder(names) {
  const ordered = FIRST.filter(table => names.has(table));
  for (const table of [...names].sort()) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

// Replay into a new sqlite file, then run the same checks as backupRoom.
export function replayNdjson(ndjson, filename) {
  if (!filename) throw new Error("Missing replay paths");
  const { watermark, byTable } = parseExport(ndjson);
  const directory = dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(filename)) throw new Error("Refusing to replay into an existing store");
  const store = new RoomStore(filename);
  try {
    const existing = new Set(tableNames(store.db));
    const order = insertOrder(new Set(byTable.keys()));
    for (const table of order) if (!existing.has(table)) throw new Error("Export names a table this store does not have");
    store.db.exec("PRAGMA foreign_keys=OFF");
    store.transaction(() => {
      for (const table of order) store.db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      for (const table of order) {
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
    });
    store.db.exec("PRAGMA foreign_keys=ON");
    if (store.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored store failed foreign key check");
    const recovery = auditRecovery(store);
    const audit = store.verifyInvitationAudit();
    const events = store.db.prepare("SELECT count(*) AS n FROM events").get().n;
    if (events !== watermark.events) throw new Error("Export watermark does not match the restored event log");
    chmodSync(filename, 0o600);
    return { verified: true, events, ...audit, recovery };
  } finally { store.close(); }
}
