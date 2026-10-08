// Daily Durable Object backup. The cron calls this when the owning script
// has an R2 binding named ROOM_BACKUPS or, failing that, a Workers KV
// binding named ROOM_BACKUPS_KV. No binding means skip. A binding that is
// missing the methods it needs is an error, so a broken target is logged
// instead of looking like a quiet success.
//
// KV caps one value at 25 MiB, so the KV target stores the export in parts
// of at most BACKUP_KV_PART_BYTES and writes the manifest last, under the
// same key the R2 object would use. A day with no manifest has no complete
// backup; parts without a manifest are an aborted run and expire on their own.
import { createHash } from "node:crypto";

export const BACKUP_BINDING = "ROOM_BACKUPS";
export const BACKUP_KV_BINDING = "ROOM_BACKUPS_KV";
export const BACKUP_PREFIX = "room-backups/";
export const BACKUP_KV_PART_BYTES = 16 * 1024 * 1024;
// 35 days: a month of nightly copies, and storage stays bounded without a sweep.
export const BACKUP_KV_TTL_SECONDS = 35 * 24 * 60 * 60;
// Version 2: BLOB cells (room file bytes) are base64 on the Durable Object
// too. A version 1 manifest for today was written by the export that dropped
// them, so the next tick rewrites that day instead of skipping it.
export const BACKUP_MANIFEST_VERSION = 2;

export function backupObjectKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${BACKUP_PREFIX}${year}-${month}-${day}.ndjson`;
}

export function backupPartKey(key, index) {
  return `${key}.part-${String(index).padStart(4, "0")}`;
}

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

export function backupTarget(env) {
  if (backupBucket(env)) return "r2";
  if (backupKv(env)) return "kv";
  return null;
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function* byteChunks(body) {
  if (typeof body === "string") { yield new TextEncoder().encode(body); return; }
  if (body instanceof Uint8Array) { yield body; return; }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield typeof value === "string" ? new TextEncoder().encode(value) : value;
    }
  } finally { reader.releaseLock?.(); }
}

// Streams the export into parts so at most one part sits in memory.
export async function writeKvBackup(kv, key, body, { partBytes = BACKUP_KV_PART_BYTES, ttlSeconds = BACKUP_KV_TTL_SECONDS, now = Date.now() } = {}) {
  const whole = createHash("sha256");
  const parts = [];
  let pending = [];
  let pendingBytes = 0;
  let total = 0;
  const options = { expirationTtl: ttlSeconds };
  const flush = async () => {
    if (!pendingBytes && parts.length) return;
    const bytes = concatBytes(pending, pendingBytes);
    const partKey = backupPartKey(key, parts.length);
    await kv.put(partKey, bytes, options);
    parts.push({ key: partKey, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    pending = [];
    pendingBytes = 0;
  };
  for await (let chunk of byteChunks(body)) {
    whole.update(chunk);
    total += chunk.byteLength;
    while (chunk.byteLength) {
      const room = partBytes - pendingBytes;
      const take = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      pending.push(take);
      pendingBytes += take.byteLength;
      chunk = chunk.byteLength <= room ? new Uint8Array(0) : chunk.subarray(room);
      if (pendingBytes >= partBytes) await flush();
    }
  }
  if (pendingBytes || !parts.length) await flush();
  const manifest = { kind: "room-backup-manifest", version: BACKUP_MANIFEST_VERSION, key, createdAt: new Date(now).toISOString(), bytes: total, sha256: whole.digest("hex"), parts };
  await kv.put(key, JSON.stringify(manifest), { ...options, metadata: { parts: parts.length, bytes: total } });
  return manifest;
}

function currentManifest(stored) {
  if (stored == null) return false;
  try {
    const text = typeof stored === "string" ? stored : new TextDecoder().decode(stored);
    return Number(JSON.parse(text)?.version) >= BACKUP_MANIFEST_VERSION;
  } catch { return false; }
}

export async function writeDailyBackup(env, room, now = new Date()) {
  const bucket = backupBucket(env);
  const kv = bucket ? null : backupKv(env);
  if (!bucket && !kv) return { skipped: "unconfigured" };
  const key = backupObjectKey(now);
  if (bucket) {
    if (await bucket.head(key)) return { skipped: "exists", key };
    const body = await room.exportRoomNdjson();
    await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
    return { wrote: key };
  }
  if (currentManifest(await kv.get(key))) return { skipped: "exists", key, target: "kv" };
  const body = await room.exportRoomNdjson();
  const manifest = await writeKvBackup(kv, key, body, { now: new Date(now).getTime() });
  return { wrote: key, target: "kv", parts: manifest.parts.length, bytes: manifest.bytes };
}
