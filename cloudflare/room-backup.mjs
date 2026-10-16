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
// Every key of one backup (parts and manifest alike) carries that backup's
// retention-class TTL (see backupRetentionClass), so a copy expires whole:
// no part can outlive its manifest or the other way round.
//
// The R2 target stores one object per day, verified before it is written
// (see writeR2Backup): the export's sha256 is recorded in the object's
// custom metadata, and only an object carrying current verified metadata
// counts as that day's backup.
import { createHash } from "node:crypto";

export const BACKUP_BINDING = "ROOM_BACKUPS";
export const BACKUP_KV_BINDING = "ROOM_BACKUPS_KV";
export const BACKUP_PREFIX = "room-backups/";
export const BACKUP_KV_PART_BYTES = 16 * 1024 * 1024;
// Tiered retention (grandfather-father-son), replacing the flat 35-day TTL
// that kept 35 full copies. The backup's own UTC date designates its class:
// the 1st of a month is a monthly copy, a Sunday is a weekly copy, and any
// other day is a daily copy (monthly wins when the 1st is a Sunday). Each
// copy is kept for its class's span — 7 days daily, 4 weeks weekly, and
// monthly until the 1st three calendar months later — so at any moment the
// retained set covers the last 7 days, a Sunday from each of the last 4
// weeks, and the 1st of each of the last 3 months, with no sweep job: the
// per-key TTL set at write time is the whole mechanism. A designated day's
// copy also serves as that day's daily copy, so distinct retained copies
// number at most 14 (the 7 + 4 + 3 class slots, less overlaps). Retention
// changes only how long a copy lives, never what a copy holds: the export
// bytes, part hashes, manifest and trailer verification are untouched, and
// a restore from any retained class verifies exactly as before.
const DAY_SECONDS = 24 * 60 * 60;
export const BACKUP_DAILY_TTL_SECONDS = 7 * DAY_SECONDS;
export const BACKUP_WEEKLY_TTL_SECONDS = 4 * 7 * DAY_SECONDS;

export function backupRetentionClass(date) {
  const day = date instanceof Date ? date : new Date(date);
  if (day.getUTCDate() === 1) return "monthly";
  if (day.getUTCDay() === 0) return "weekly";
  return "daily";
}

export function backupTtlSeconds(date) {
  const day = date instanceof Date ? date : new Date(date);
  const retentionClass = backupRetentionClass(day);
  if (retentionClass === "daily") return BACKUP_DAILY_TTL_SECONDS;
  if (retentionClass === "weekly") return BACKUP_WEEKLY_TTL_SECONDS;
  // Monthly: a fixed second count cannot say "3 months" — the months span
  // 89–92 days — so the span is the exact day count from this month's 1st
  // to the 1st three calendar months later. The copy then expires as its
  // third successor arrives, never before and never a month late.
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();
  const first = Date.UTC(year, month, 1);
  const thirdSuccessor = Date.UTC(year, month + 3, 1);
  return (thirdSuccessor - first) / 1000;
}

export function backupRetention(date) {
  return { retentionClass: backupRetentionClass(date), ttlSeconds: backupTtlSeconds(date) };
}

// The backup date a KV key names, or null when the key is not a daily
// backup key. Retention is a function of the backup's date, and the key is
// where that date is recorded, so the writer derives the class from the
// key rather than from the wall clock at write time.
const BACKUP_KEY_DATE = /^room-backups\/(\d{4})-(\d{2})-(\d{2})\.ndjson$/;
function backupDateFromKey(key) {
  const match = BACKUP_KEY_DATE.exec(typeof key === "string" ? key : "");
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return null;
  return date;
}
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

// Write-time torn-export detection. The stream's first line is the watermark
// (event count before the first table) and its last line is the trailer
// (event count after the last table). If both parse and the counts differ, a
// write landed mid-export: refuse the manifest, so no manifest ever claims a
// torn backup is the day's good copy. Parts already written have no manifest
// and expire on their own; the job logs the failure. Both writers also
// verify the trailer hash at write time (below), which catches same-count
// tears; replayNdjson re-verifies it at restore. An absent or unparseable
// trailer (older exports) skips these checks; restore time is the backstop.
const HEAD_LINE_CAP = 1024 * 1024;
const TAIL_KEEP = 8192;

function tornReason(headLine, tailBytes) {
  try {
    const first = JSON.parse(new TextDecoder().decode(headLine));
    const lines = new TextDecoder().decode(tailBytes).split("\n").filter(line => line.trim());
    const last = JSON.parse(lines.at(-1));
    if (first?.kind !== "watermark" || last?.kind !== "trailer") return null;
    if (!Number.isSafeInteger(first.events) || !Number.isSafeInteger(last.events)) return null;
    if (first.events !== last.events) return `event count moved ${first.events} -> ${last.events} mid-export`;
    return null;
  } catch { return null; }
}

// Tracks just the first line and the last TAIL_KEEP bytes of a stream, the
// two pieces tornReason needs, without holding the whole export.
function headTailTracker() {
  let headLine = null;
  let headAcc = [];
  let headBytes = 0;
  let tail = new Uint8Array(0);
  return {
    note(chunk) {
      if (headLine === null) {
        headAcc.push(chunk);
        headBytes += chunk.byteLength;
        const joined = concatBytes(headAcc, headBytes);
        const nl = joined.indexOf(10);
        if (nl !== -1) { headLine = joined.subarray(0, nl); headAcc = []; }
        else if (headBytes > HEAD_LINE_CAP) { headLine = new Uint8Array(0); headAcc = []; }
      }
      const combined = new Uint8Array(tail.byteLength + chunk.byteLength);
      combined.set(tail, 0);
      combined.set(chunk, tail.byteLength);
      tail = combined.byteLength > TAIL_KEEP ? combined.subarray(combined.byteLength - TAIL_KEEP) : combined;
    },
    get headLine() { return headLine; },
    get tail() { return tail; }
  };
}

// The same-count tear the count check cannot see: the trailer's hash over
// every event's room_id, sequence and id, recomputed from the export's own
// event rows (the same recomputation replayNdjson's verifyTrailer does).
// An absent or unparseable trailer (older exports) skips this check.
function trailerHashReason(bytes) {
  try {
    const lines = new TextDecoder().decode(bytes).split("\n").filter(line => line.trim());
    const last = JSON.parse(lines.at(-1));
    if (last?.kind !== "trailer") return null;
    if (!Number.isSafeInteger(last.events) || typeof last.eventsHash !== "string" || !/^[0-9a-f]{64}$/.test(last.eventsHash)) return null;
    const tuples = [];
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record?.table === "events") tuples.push([record.row?.room_id, record.row?.sequence, record.row?.id]);
    }
    if (tuples.length !== last.events) return `event count moved: the trailer counts ${last.events} but the export holds ${tuples.length} events`;
    tuples.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const hash = createHash("sha256");
    for (const [roomId, sequence, id] of tuples) hash.update(`${roomId}\t${sequence}\t${id}\n`);
    if (hash.digest("hex") !== last.eventsHash) return "event log changed during the export (same count, different rows)";
    return null;
  } catch { return null; }
}

// Streaming twin of trailerHashReason for the KV writer, which never holds
// the whole export: it splits the stream into lines as bytes arrive, keeps
// only the event tuples (room_id, sequence, id — a few dozen bytes per event
// against kilobytes per exported row) plus the last line, and delivers the
// same verdict when the stream ends. #3407: without this, the KV path — the
// production target — certified a same-count torn export with a manifest and
// the day became unretryable, while the R2 path refused the identical bytes.
function trailerHashTracker() {
  const decoder = new TextDecoder();
  const tuples = [];
  let buffered = "";
  let lastLine = "";
  const noteLine = line => {
    if (!line.trim()) return;
    lastLine = line;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record?.table === "events") tuples.push([record.row?.room_id, record.row?.sequence, record.row?.id]);
  };
  return {
    note(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) noteLine(line);
    },
    finish() {
      buffered += decoder.decode();
      if (buffered) noteLine(buffered);
      buffered = "";
      try {
        const last = JSON.parse(lastLine);
        if (last?.kind !== "trailer") return null;
        if (!Number.isSafeInteger(last.events) || typeof last.eventsHash !== "string" || !/^[0-9a-f]{64}$/.test(last.eventsHash)) return null;
        if (tuples.length !== last.events) return `event count moved: the trailer counts ${last.events} but the export holds ${tuples.length} events`;
        tuples.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
        const hash = createHash("sha256");
        for (const [roomId, sequence, id] of tuples) hash.update(`${roomId}\t${sequence}\t${id}\n`);
        if (hash.digest("hex") !== last.eventsHash) return "event log changed during the export (same count, different rows)";
        return null;
      } catch { return null; }
    }
  };
}

// Streams the export into parts so at most one part sits in memory.
// Without an explicit ttlSeconds override, every key written here (parts
// and the manifest, written last) gets the TTL of the retention class the
// backup's date designates (backupRetention). An explicit override is a
// caller/test escape hatch and bypasses tiering for that one backup.
export async function writeKvBackup(kv, key, body, { partBytes = BACKUP_KV_PART_BYTES, ttlSeconds, now = Date.now() } = {}) {
  if (ttlSeconds === undefined) ttlSeconds = backupTtlSeconds(backupDateFromKey(key) ?? new Date(now));
  const whole = createHash("sha256");
  const parts = [];
  let pending = [];
  let pendingBytes = 0;
  let total = 0;
  const options = { expirationTtl: ttlSeconds };
  const tracker = headTailTracker();
  const hashTracker = trailerHashTracker();
  const noteHeadTail = chunk => { tracker.note(chunk); hashTracker.note(chunk); };
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
    noteHeadTail(chunk);
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
  if (tracker.headLine !== null) {
    const reason = tornReason(tracker.headLine, tracker.tail);
    if (reason) throw new Error(`room-backup: refusing manifest, export torn (${reason})`);
  }
  const hashReason = hashTracker.finish();
  if (hashReason) throw new Error(`room-backup: refusing manifest, export torn (${hashReason})`);
  if (pendingBytes || !parts.length) await flush();
  const manifest = { kind: "room-backup-manifest", version: BACKUP_MANIFEST_VERSION, key, createdAt: new Date(now).toISOString(), bytes: total, sha256: whole.digest("hex"), parts };
  await kv.put(key, JSON.stringify(manifest), { ...options, metadata: { parts: parts.length, bytes: total } });
  return manifest;
}

// An R2 object counts as the day's backup only when the verified writer
// below stored it: its custom metadata carries the sha256 of its exact
// bytes at the current backup version. An object with no such metadata —
// anything the pre-fix writer stored, torn or not — is not a backup, so
// head() alone never makes the day unretryable.
function verifiedR2Backup(stored) {
  if (stored == null) return false;
  const meta = stored.customMetadata;
  if (!meta || typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256)) return false;
  if (!Number.isSafeInteger(Number(meta.backupVersion)) || Number(meta.backupVersion) < BACKUP_MANIFEST_VERSION) return false;
  if (meta.bytes !== undefined && Number.isSafeInteger(stored.size) && Number(meta.bytes) !== stored.size) return false;
  return true;
}

// R2 has no manifest-last trick: a put under the day's key is the commit,
// and it cannot be taken back once it lands. So the export is held until
// it has been verified — the watermark/trailer count check the KV writer
// uses, plus the trailer hash check, plus a sha256 over the exact bytes —
// and only then written, once, with that sha256 in its custom metadata.
// A torn export throws before any put, so nothing is stored under the
// day's key and the next tick the same day can retry. Holding the bytes is
// the cost of verifying before the single-object commit; the KV target
// above remains the streaming path for large exports.
async function writeR2Backup(bucket, key, body) {
  const whole = createHash("sha256");
  const tracker = headTailTracker();
  const chunks = [];
  let total = 0;
  for await (const chunk of byteChunks(body)) {
    tracker.note(chunk);
    whole.update(chunk);
    total += chunk.byteLength;
    chunks.push(chunk);
  }
  if (tracker.headLine !== null) {
    const reason = tornReason(tracker.headLine, tracker.tail);
    if (reason) throw new Error(`room-backup: refusing to store export, export torn (${reason})`);
  }
  const bytes = concatBytes(chunks, total);
  const hashReason = trailerHashReason(bytes);
  if (hashReason) throw new Error(`room-backup: refusing to store export, export torn (${hashReason})`);
  const sha256 = whole.digest("hex");
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { sha256, bytes: String(total), backupVersion: String(BACKUP_MANIFEST_VERSION) }
  });
  return { bytes: total, sha256 };
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
    if (verifiedR2Backup(await bucket.head(key))) return { skipped: "exists", key };
    const body = await room.exportRoomNdjson();
    await writeR2Backup(bucket, key, body);
    return { wrote: key };
  }
  if (currentManifest(await kv.get(key))) return { skipped: "exists", key, target: "kv" };
  const body = await room.exportRoomNdjson();
  const manifest = await writeKvBackup(kv, key, body, { now: new Date(now).getTime() });
  return { wrote: key, target: "kv", parts: manifest.parts.length, bytes: manifest.bytes };
}
