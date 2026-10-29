// Restore a nightly backup into a NEW sqlite store. Never touches a live
// room: the destination must not exist, and nothing here writes to
// Cloudflare. Prints counts and digests only, never row contents.
//
//   node scripts/restore-room-backup.mjs --kv 2026-10-08 --to /tmp/restore/room.sqlite --room muse-room
//   node scripts/restore-room-backup.mjs --from room-export.ndjson --to /tmp/restore/room.sqlite
//
// --kv reads the KV manifest and its parts with `wrangler kv key get --remote`
// (the caller's wrangler login), checks every part's sha256 and the whole
// file's sha256, then replays. --save writes the reassembled NDJSON (mode 0600).
// --audit report restores even when the recovery audit flags drift between a
// stored projection and the current reducer, and prints the audit result.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { replayNdjson } from "../server/room-export.mjs";
import { backupObjectKey } from "../cloudflare/room-backup.mjs";

export const DEFAULT_NAMESPACE_ID = "ee73a90c4e6749bb92ebe16fc57c117d";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function kvGet(namespaceId, key, { wrangler = process.env.WRANGLER ?? "wrangler" } = {}) {
  return execFileSync(wrangler, ["kv", "key", "get", "--remote", "--namespace-id", namespaceId, key], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

// Reassembles a KV backup. `get(key)` returns the stored bytes (Buffer).
export function assembleKvBackup(manifestBytes, get) {
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  if (manifest?.kind !== "room-backup-manifest" || !Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error("Not a room backup manifest");
  const parts = manifest.parts.map(part => {
    const bytes = Buffer.from(get(part.key));
    if (bytes.byteLength !== part.bytes || sha256(bytes) !== part.sha256) throw new Error(`Backup part ${part.key} does not match its manifest`);
    return bytes;
  });
  const whole = Buffer.concat(parts);
  if (whole.byteLength !== manifest.bytes || sha256(whole) !== manifest.sha256) throw new Error("Reassembled backup does not match its manifest");
  return { manifest, ndjson: whole.toString("utf8") };
}

// Per-room summary of a restored store. Messages are room messages that are
// not DMs, with edits applied, so a member's reader can compute the same
// digest from the live events API.
export function summarizeRoom(filename, roomId) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId);
    const parsed = rows.map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
    // The live events API shows an edited message's current text on its
    // message.posted event, so the digest applies message.edited (last wins).
    const edited = new Map();
    for (const { event } of parsed) {
      if (event?.type === "message.edited" && typeof event.data?.body === "string") edited.set(event.data.messageId, event.data.body);
    }
    const digest = createHash("sha256");
    let messages = 0;
    for (const { sequence, event } of parsed) {
      if (event?.type !== "message.posted" || event.data?.toMemberId) continue;
      messages += 1;
      const current = edited.has(event.data?.messageId) ? { ...event, data: { ...event.data, body: edited.get(event.data.messageId) } } : event;
      digest.update(messageDigestLine(sequence, current));
    }
    const room = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
    return { roomId, found: Boolean(room), sequence: room?.sequence ?? null, events: rows.length, firstSequence: rows[0]?.sequence ?? null, lastSequence: rows.at(-1)?.sequence ?? null, messages, messagesSha256: digest.digest("hex") };
  } finally { db.close(); }
}

export function messageDigestLine(sequence, event) {
  return `${sequence}\t${event.id}\t${event.data?.messageId ?? ""}\t${event.data?.body ?? ""}\n`;
}

const restoreOutcome = { promoted: false, cleanupFailed: false };

async function main() {
  const { values } = parseArgs({ options: {
    from: { type: "string" }, kv: { type: "string" }, "namespace-id": { type: "string" },
    to: { type: "string" }, room: { type: "string", multiple: true }, save: { type: "string" }, audit: { type: "string" }
  } });
  process.umask(0o077);
  if (!values.to) throw new Error("Pass --to <new sqlite path>");
  if (existsSync(values.to)) throw new Error("Refusing to restore over an existing file");
  if (Boolean(values.from) === Boolean(values.kv)) throw new Error("Pass exactly one of --from <ndjson> or --kv <YYYY-MM-DD>");
  let ndjson, manifest = null;
  if (values.from) ndjson = readFileSync(values.from, "utf8");
  else {
    const namespaceId = values["namespace-id"] ?? DEFAULT_NAMESPACE_ID;
    const key = backupObjectKey(new Date(`${values.kv}T00:00:00Z`));
    ({ manifest, ndjson } = assembleKvBackup(kvGet(namespaceId, key), partKey => kvGet(namespaceId, partKey)));
  }
  if (values.save) writeFileSync(values.save, ndjson, { mode: 0o600, flag: "wx" });
  const watermark = JSON.parse(ndjson.slice(0, ndjson.indexOf("\n")));
  // A destination can appear while input is downloaded. Never replay or clean
  // up at a path another process could have claimed after the initial check.
  // Stage on the same filesystem, then publish with an atomic no-replace link.
  const parent = dirname(values.to);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, ".room-restore-"));
  const stagedFile = join(staging, "room.sqlite");
  let result, rooms, replayError;
  try {
    result = replayNdjson(ndjson, stagedFile, { audit: values.audit ?? "strict" });
    rooms = (values.room ?? []).map(roomId => summarizeRoom(stagedFile, roomId));
    if (["-wal", "-shm"].some(suffix => existsSync(`${values.to}${suffix}`)))
      throw new Error("Refusing to restore beside existing SQLite sidecars");
    linkSync(stagedFile, values.to);
    restoreOutcome.promoted = true;
  } catch (error) {
    replayError = error;
    throw error;
  } finally {
    // Only this run's private directory is ours to remove, even on failure.
    try { rmSync(staging, { recursive: true, force: true }); }
    catch (error) {
      restoreOutcome.cleanupFailed = true;
      if (!replayError) throw error;
    }
  }
  process.stdout.write(`${JSON.stringify({
    verified: result.verified, events: result.events, trailer: result.trailer, contentVerification: result.contentVerification, audit: result.audit, skippedTables: result.skippedTables, sanitizedCells: result.sanitizedCells, roomsInBackup: watermark.rooms?.length ?? null,
    backedUpAt: watermark.backedUpAt ? new Date(watermark.backedUpAt).toISOString() : null,
    manifest: manifest && { key: manifest.key, bytes: manifest.bytes, parts: manifest.parts.length, sha256: manifest.sha256 },
    rooms
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const destination = restoreOutcome.promoted ? "The destination was promoted; preserve it and inspect before retrying." : "The destination was not promoted.";
    const cleanup = restoreOutcome.cleanupFailed ? " Private staging cleanup failed; a private copy may remain beside the destination." : "";
    process.stderr.write(`Restore failed: ${String(error?.message ?? error).split("\n")[0]}. ${destination}${cleanup}\n`);
    process.exitCode = 1;
  });
}
