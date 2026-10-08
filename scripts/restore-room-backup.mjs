// Restore drill for the hosted room's daily backup. It never touches a live
// room: it reads one daily copy (KV namespace ROOM_BACKUPS_KV on the
// production script, or a local NDJSON export), replays it into a NEW sqlite
// room under a fresh private directory, and proves the restored event log
// matches the backup row for row. The directory is deleted at the end unless
// --keep is given. Row contents are never printed.
//
//   node scripts/restore-room-backup.mjs                 # latest KV copy
//   node scripts/restore-room-backup.mjs --date 2026-10-08
//   node scripts/restore-room-backup.mjs --from room-export.ndjson --keep
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { replayNdjson } from "../server/room-export.mjs";
import { BACKUP_KV_BINDING, BACKUP_PREFIX, kvManifestKey } from "../cloudflare/room-backup.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const cloudflareDir = fileURLToPath(new URL("../cloudflare/", import.meta.url));

function wrangler(args) {
  return execFileSync("npx", ["--no-install", "wrangler", ...args, "--binding", BACKUP_KV_BINDING, "--env", "production", "--remote"],
    { cwd: cloudflareDir, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
}

function latestDate() {
  const keys = JSON.parse(wrangler(["kv", "key", "list", "--prefix", BACKUP_PREFIX]).toString("utf8"));
  const dates = keys.map(key => /^room-backups\/(\d{4}-\d{2}-\d{2})\/manifest$/.exec(key.name)?.[1]).filter(Boolean).sort();
  if (!dates.length) throw new Error("No daily backup manifest in ROOM_BACKUPS_KV yet");
  return dates.at(-1);
}

export function fetchKvBackup(date, get = key => wrangler(["kv", "key", "get", key])) {
  const manifest = JSON.parse(get(kvManifestKey(date)).toString("utf8"));
  if (manifest?.kind !== "room-backup-manifest" || !Array.isArray(manifest.parts)) throw new Error("Backup manifest is malformed");
  const parts = manifest.parts.map(part => {
    const bytes = Buffer.from(get(part.key));
    if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256) throw new Error(`Backup part ${part.key} does not match its manifest`);
    return bytes;
  });
  const body = Buffer.concat(parts);
  if (body.length !== manifest.bytes) throw new Error("Backup size does not match its manifest");
  return { manifest, ndjson: body.toString("utf8") };
}

// Per-room event and message counts plus one digest over every event row,
// computed the same way from the backup text and from the restored room.
export function summarizeEvents(rows) {
  const rooms = {};
  const digest = createHash("sha256");
  rows.sort((a, b) => a.room_id < b.room_id ? -1 : a.room_id > b.room_id ? 1 : a.sequence - b.sequence);
  for (const row of rows) {
    const room = rooms[row.room_id] ??= { events: 0, messages: 0 };
    room.events += 1;
    let type = null;
    try { type = JSON.parse(row.body)?.type ?? null; } catch { /* body is opaque */ }
    if (type === "message.posted") room.messages += 1;
    digest.update(JSON.stringify([row.room_id, row.sequence, row.id, row.body]));
  }
  const total = Object.values(rooms).reduce((sum, room) => ({ events: sum.events + room.events, messages: sum.messages + room.messages }), { events: 0, messages: 0 });
  return { rooms: Object.keys(rooms).length, ...total, digest: digest.digest("hex"), perRoom: rooms };
}

export function summarizeExport(ndjson) {
  const rows = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.table === "events") rows.push(record.row);
  }
  return summarizeEvents(rows);
}

export function summarizeStore(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return summarizeEvents(db.prepare("SELECT room_id, sequence, id, body FROM events").all()); }
  finally { db.close(); }
}

export function restoreDrill(ndjson, directory) {
  const exported = summarizeExport(ndjson);
  const filename = join(directory, "restored-room.sqlite");
  const replay = replayNdjson(ndjson, filename);
  const restored = summarizeStore(filename);
  const match = exported.digest === restored.digest && exported.events === restored.events && exported.messages === restored.messages && replay.events === exported.events;
  return { filename, replay, exported, restored, match };
}

async function main() {
  const { values } = parseArgs({ options: { date: { type: "string" }, from: { type: "string" }, keep: { type: "boolean" }, rooms: { type: "string" } } });
  process.umask(0o077);
  const directory = mkdtempSync(join(tmpdir(), "room-restore-drill-"));
  try {
    let source, manifest = null, ndjson;
    if (values.from) { ndjson = readFileSync(values.from, "utf8"); source = "file"; }
    else {
      const date = values.date ?? latestDate();
      ({ manifest, ndjson } = fetchKvBackup(date));
      source = `kv:${kvManifestKey(date)}`;
      writeFileSync(join(directory, "backup.ndjson"), ndjson, { mode: 0o600 });
    }
    const result = restoreDrill(ndjson, directory);
    const watermark = JSON.parse(ndjson.slice(0, ndjson.indexOf("\n")));
    const report = {
      source, backedUpAt: new Date(watermark.backedUpAt).toISOString(), bytes: Buffer.byteLength(ndjson),
      manifestEvents: manifest?.events ?? null, watermarkEvents: watermark.events,
      exported: { rooms: result.exported.rooms, events: result.exported.events, messages: result.exported.messages, digest: result.exported.digest },
      restored: { rooms: result.restored.rooms, events: result.restored.events, messages: result.restored.messages, digest: result.restored.digest },
      skippedTables: result.replay.skipped, verified: result.replay.verified, match: result.match && watermark.events === result.restored.events,
      kept: values.keep ? directory : null
    };
    if (values.rooms) report.perRoom = Object.fromEntries(values.rooms.split(",").map(id => [id, { exported: result.exported.perRoom[id] ?? null, restored: result.restored.perRoom[id] ?? null }]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.match) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Restore drill failed: ${String(error?.message ?? error).split("\n")[0]}\n`);
    process.exitCode = 1;
  } finally {
    if (!values.keep) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
