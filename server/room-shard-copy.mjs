// Copy one room's room-tables from the pilot database into a shard database.
// Rows keep their primary keys. Directory tables are not read. This is not
// on the command path: nothing in the Worker calls it unless a later step
// does, and only when the caller asks.
import { createHash } from "node:crypto";
import { perRoomObjectsEnabled } from "./room-shard-flag.mjs";
import { BACKUP_SANITIZE_POLICY, createTableDigests, replayNdjson, sanitizeCell } from "./room-export.mjs";
import { ROOM_TABLE_KEYS, roomKeyColumn, roomTablesPresent } from "./room-shard-tables.mjs";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const FIRST = ["rooms", "events", "commands"];

function quoteIdent(name) {
  if (!IDENT.test(name)) throw new Error("Room shard table name is not safe to copy");
  return `"${name}"`;
}

export function roomCopyOrder() {
  const rest = Object.keys(ROOM_TABLE_KEYS).filter(name => !FIRST.includes(name)).sort();
  return [...FIRST, ...rest];
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(column => column.name);
}

function assertRoomId(roomId) {
  if (typeof roomId !== "string" || roomId.length === 0 || roomId === "invite-only-pilot") {
    throw new Error("Room id is required");
  }
}

function dbOf(storeOrDb) {
  return storeOrDb?.db ?? storeOrDb;
}

export function copyRoomRows(pilot, shard, roomId) {
  assertRoomId(roomId);
  if (typeof shard?.transaction !== "function") throw new Error("Shard copy needs a store transaction");
  const pilotDb = dbOf(pilot);
  const shardDb = dbOf(shard);
  const order = roomCopyOrder();
  shard.transaction(() => {
    // Foreign keys stay on inside a transaction, so children go before rooms
    // and the insert walks the opposite way.
    const plans = order.map(table => {
      const key = roomKeyColumn(table);
      const columns = columnsOf(shardDb, table);
      if (!columns.includes(key)) throw new Error(`Shard table ${table} is missing ${key}`);
      const name = quoteIdent(table);
      return {
        table,
        key,
        columns,
        name,
        quoted: columns.map(quoteIdent).join(", "),
      };
    });
    for (const plan of [...plans].reverse()) {
      shardDb.prepare(`DELETE FROM ${plan.name} WHERE ${quoteIdent(plan.key)} = ?`).run(roomId);
    }
    for (const plan of plans) {
      const rows = pilotDb.prepare(`SELECT ${plan.quoted} FROM ${plan.name} WHERE ${quoteIdent(plan.key)} = ?`).all(roomId);
      if (!rows.length) continue;
      const insert = shardDb.prepare(`INSERT INTO ${plan.name} (${plan.quoted}) VALUES (${plan.columns.map(() => "?").join(", ")})`);
      for (const row of rows) insert.run(...plan.columns.map(column => row[column]));
    }
  });
  return { roomId, tables: order.length };
}

export function roomHomeDigest(storeOrDb, roomId) {
  assertRoomId(roomId);
  const db = dbOf(storeOrDb);
  const rows = db.prepare("SELECT sequence, id, body FROM events WHERE room_id = ? ORDER BY sequence").all(roomId);
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${row.sequence}\t${row.id}\t${row.body}\n`);
  const messages = db.prepare("SELECT count(*) AS n FROM messages WHERE room_id = ?").get(roomId).n;
  const projection = db.prepare("SELECT projection FROM rooms WHERE id = ?").get(roomId);
  const projectionBytes = projection ? Buffer.byteLength(projection.projection) : 0;
  return { events: rows.length, eventsHash: hash.digest("hex"), messages, projectionBytes };
}

// Dual-write is another copy of the same primary keys, not a second
// store.command. Flag off leaves the shard untouched. The Worker does not
// call this from the command path.
export function mirrorRoomIfEnabled(env, pilot, shard, roomId) {
  if (!perRoomObjectsEnabled(env)) return { mirrored: false };
  copyRoomRows(pilot, shard, roomId);
  return { mirrored: true };
}

export function compareRoomHomes(pilot, shard, roomId) {
  const left = roomHomeDigest(dbOf(pilot), roomId);
  const right = roomHomeDigest(dbOf(shard), roomId);
  const same = left.events === right.events
    && left.eventsHash === right.eventsHash
    && left.messages === right.messages
    && left.projectionBytes === right.projectionBytes;
  return { same, pilot: left, shard: right };
}

function sanitizeRow(table, row) {
  const out = {};
  for (const [column, value] of Object.entries(row)) out[column] = sanitizeCell(table, column, value);
  return out;
}

// One room's room-tables as NDJSON. The watermark and trailer count that
// room's events only, so replayNdjson can load the slice into an empty file.
export function exportRoomNdjson(storeOrDb, roomId) {
  assertRoomId(roomId);
  const db = dbOf(storeOrDb);
  const room = db.prepare("SELECT id, sequence FROM rooms WHERE id = ?").get(roomId);
  if (!room) throw new Error("Room is not on the pilot");
  const lines = [JSON.stringify({
    kind: "watermark", version: 1, sanitizePolicy: BACKUP_SANITIZE_POLICY,
    backedUpAt: Date.now(), rooms: [room],
    events: db.prepare("SELECT count(*) AS n FROM events WHERE room_id = ?").get(roomId).n,
  }) + "\n"];
  const digests = createTableDigests();
  for (const table of roomCopyOrder()) {
    const key = roomKeyColumn(table);
    const columns = columnsOf(db, table);
    const quoted = columns.map(quoteIdent).join(", ");
    const rows = db.prepare(`SELECT ${quoted} FROM ${quoteIdent(table)} WHERE ${quoteIdent(key)} = ?`).all(roomId);
    for (const row of rows) {
      const sanitized = sanitizeRow(table, row);
      digests.add(table, sanitized);
      lines.push(JSON.stringify({ table, row: sanitized }) + "\n");
    }
  }
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT room_id, sequence, id FROM events WHERE room_id = ? ORDER BY room_id, sequence").all(roomId)) {
    hash.update(`${sanitizeCell("events", "room_id", row.room_id)}\t${sanitizeCell("events", "sequence", row.sequence)}\t${sanitizeCell("events", "id", row.id)}\n`);
  }
  const tables = digests.finish();
  const trailer = { kind: "trailer", version: 1, events: db.prepare("SELECT count(*) AS n FROM events WHERE room_id = ?").get(roomId).n, eventsHash: hash.digest("hex") };
  if (Object.keys(tables).length) {
    trailer.version = 2;
    trailer.tables = tables;
  }
  lines.push(JSON.stringify(trailer) + "\n");
  return lines.join("");
}

// Replay a room slice. Directory tables and unknown tables fail with the
// same error a pilot restore uses for a table the store does not have.
// The file keeps the full schema so existing triggers still run; directory
// rows from the export are not loaded.
export function restoreRoomNdjson(ndjson, filename) {
  return replayNdjson(ndjson, filename, { audit: "strict", retainTables: roomTablesPresent });
}
