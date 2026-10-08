// Daily Durable Object backup. The cron calls this when the owning script has
// an R2 binding named ROOM_BACKUPS or a KV binding named ROOM_BACKUPS_KV.
// R2 wins when both are bound. No binding means skip. A binding that is
// missing the methods we need is an error, so a broken binding is logged
// instead of looking like a quiet success.
export const BACKUP_BINDING = "ROOM_BACKUPS";
export const BACKUP_KV_BINDING = "ROOM_BACKUPS_KV";
export const BACKUP_PREFIX = "room-backups/";
// KV values top out at 25 MiB. Byte-bounded parts are reassembled before
// decoding: oversized rows may span parts, including within UTF-8 characters.
export const KV_PART_BYTES = 8 * 1024 * 1024;
// KV copies expire on their own; 35 daily copies are kept.
export const KV_RETENTION_SECONDS = 35 * 24 * 60 * 60;

export function backupDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function backupObjectKey(now = new Date()) {
  return `${BACKUP_PREFIX}${backupDate(now)}.ndjson`;
}

export function kvManifestKey(date) { return `${BACKUP_PREFIX}${date}/manifest`; }
export function kvPartKey(date, index) { return `${BACKUP_PREFIX}${date}/part-${String(index).padStart(4, "0")}`; }

function backupBucket(env) {
  const bucket = env?.[BACKUP_BINDING];
  if (bucket == null) return null;
  if (typeof bucket.put !== "function" || typeof bucket.head !== "function") throw new Error("ROOM_BACKUPS binding is missing put or head");
  return bucket;
}

function backupKv(env) {
  const kv = env?.[BACKUP_KV_BINDING];
  if (kv == null) return null;
  if (typeof kv.put !== "function" || typeof kv.get !== "function") throw new Error("ROOM_BACKUPS_KV binding is missing put or get");
  return kv;
}

export function backupConfigured(env) {
  const bucket = env?.[BACKUP_BINDING];
  const kv = env?.[BACKUP_KV_BINDING];
  return Boolean((bucket && typeof bucket.put === "function" && typeof bucket.head === "function")
    || (kv && typeof kv.put === "function" && typeof kv.get === "function"));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function joinBytes(chunks, length) {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

// Each export chunk is one line. Keep ordinary lines together, but split
// oversized rows to enforce the byte limit. The manifest goes last; a
// half-written day has no manifest and the next tick writes it again.
async function writeKvBackup(kv, room, now, partBytes) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > KV_PART_BYTES) throw new RangeError("Backup part size must be between 1 byte and 8 MiB");
  const date = backupDate(now);
  const manifestKey = kvManifestKey(date);
  if (await kv.get(manifestKey)) return { skipped: "exists", key: manifestKey };
  const options = { expirationTtl: KV_RETENTION_SECONDS };
  const reader = (await room.exportRoomNdjson()).getReader();
  const parts = [];
  let pending = [], pendingBytes = 0, bytes = 0, lines = 0, watermark = null;
  const decoder = new TextDecoder();
  const flush = async () => {
    if (!pendingBytes) return;
    const body = joinBytes(pending, pendingBytes);
    const key = kvPartKey(date, parts.length);
    await kv.put(key, body, options);
    parts.push({ key, bytes: body.length, sha256: await sha256Hex(body) });
    pending = []; pendingBytes = 0;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === "string" ? new TextEncoder().encode(value) : value;
      if (!watermark) {
        try { watermark = JSON.parse(decoder.decode(chunk)); } catch { watermark = {}; }
      }
      if (pendingBytes && pendingBytes + chunk.length > partBytes) await flush();
      for (let offset = 0; offset < chunk.length;) {
        const length = Math.min(partBytes - pendingBytes, chunk.length - offset);
        pending.push(chunk.subarray(offset, offset + length));
        pendingBytes += length; offset += length;
        if (pendingBytes === partBytes) await flush();
      }
      bytes += chunk.length; lines += 1;
    }
    await flush();
  } catch (error) {
    try { await reader.cancel(error); } catch { /* Preserve the original write failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const manifest = {
    kind: "room-backup-manifest", version: 1, date, createdAt: new Date(now).toISOString(),
    bytes, lines, events: Number.isSafeInteger(watermark?.events) ? watermark.events : null,
    rooms: Array.isArray(watermark?.rooms) ? watermark.rooms.length : null, parts
  };
  await kv.put(manifestKey, JSON.stringify(manifest), options);
  return { wrote: manifestKey, parts: parts.length, bytes, events: manifest.events };
}

export async function writeDailyBackup(env, room, now = new Date(), { partBytes = KV_PART_BYTES } = {}) {
  const bucket = backupBucket(env);
  if (bucket) {
    const key = backupObjectKey(now);
    if (await bucket.head(key)) return { skipped: "exists", key };
    const body = await room.exportRoomNdjson();
    await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
    return { wrote: key };
  }
  const kv = backupKv(env);
  if (kv) return writeKvBackup(kv, room, now, partBytes);
  return { skipped: "unconfigured" };
}
