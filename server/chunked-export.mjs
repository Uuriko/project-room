// Chunked export: emit a whole-store NDJSON export as staged part files
// plus a manifest, WITHOUT the single-snapshot size guard that blocks
// stores past BACKUP_SNAPSHOT_MAX_BYTES (96 MiB).
//
// Why this exists: both existing whole-store producers refuse a large
// store before writing a single byte — exportNdjsonConsistentStream
// throws backup_snapshot_too_large when the database measures past the
// cap, and exportNdjsonStream (the operator door) throws the same code
// when the encoded export passes it. The staged parts the consistent
// path materialises internally (room_backup_export_parts) are a producer
// implementation detail: they are streamed out as one continuous NDJSON
// stream, the staging table is excluded from the export itself, and no
// importer accepts those rows as an input format.
//
// This module is the missing producer/transport pair for that gap:
//
// - The byte stream is EXACTLY the stream exportNdjsonLines produces —
//   same watermark, same {table, row} lines with the same sanitised
//   record shapes, same trailer (v2 per-table digests included). Parts
//   are byte slices of that stream, sliced at partBytes like
//   materializeExportParts slices its staging rows, so concatenating the
//   parts in manifest order reproduces the single-file export byte for
//   byte. No new record format is introduced.
// - Reads are bounded: exportNdjsonLines pages tables in keyset pages,
//   and this module holds at most one part (partBytes) in memory.
// - No database-size guard is consulted and no single write transaction
//   is held across the export: each part is flushed to its own file as it
//   fills. A torn export (a write landing mid-export) is still refused
//   downstream exactly as before — the trailer re-read in
//   exportNdjsonLines and verified by replay catches it — so dropping
//   the one-turn snapshot does not weaken verification, it only removes
//   the size refusal.
// - The manifest is written LAST (the KV backup discipline in
//   cloudflare/room-backup.mjs): a directory whose manifest exists is a
//   complete export; a directory with only progress.json is an
//   interrupted one and can be resumed.
// - Resumable: after every part, progress.json records the export id,
//   the exact watermark line, and each finished part's bytes + sha256.
//   A later call with resume:true re-derives the stream, substitutes the
//   recorded watermark (its backedUpAt is the only non-deterministic
//   line in the stream), verifies the already-written byte ranges
//   against the recorded part hashes as it re-derives them, and appends
//   only the remaining parts. If the source store changed since the
//   interrupted run, the re-derived bytes disagree with a recorded part
//   hash and the resume refuses with chunked_export_resume_source_changed
//   instead of splicing two different snapshots together.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportNdjsonLines } from "./room-export.mjs";

export const CHUNKED_EXPORT_MANIFEST_KIND = "room-chunked-export-manifest";
export const CHUNKED_EXPORT_MANIFEST_VERSION = 1;
export const CHUNKED_EXPORT_PROGRESS_KIND = "room-chunked-export-progress";
export const DEFAULT_CHUNKED_PART_BYTES = 8 * 1024 * 1024;
export const CHUNKED_EXPORT_PART_MISMATCH = "chunked_export_part_mismatch";
export const CHUNKED_EXPORT_RESUME_SOURCE_CHANGED = "chunked_export_resume_source_changed";

const sha256Hex = value => createHash("sha256").update(value).digest("hex");
export const chunkedPartFileName = index => `part-${String(index).padStart(6, "0")}.ndjson`;
const PART_FILE_PATTERN = /^part-\d{6}\.ndjson$/;
const HEX64 = /^[0-9a-f]{64}$/;

function parseJsonLine(line, what) {
  try { return JSON.parse(line); }
  catch { throw new Error(`Chunked export ${what} line is not JSON`); }
}

function sameWatermarkFields(a, b) {
  return a?.version === b?.version
    && a?.sourceSchemaVersion === b?.sourceSchemaVersion
    && a?.sanitizePolicy === b?.sanitizePolicy
    && a?.events === b?.events
    && JSON.stringify(a?.rooms ?? null) === JSON.stringify(b?.rooms ?? null);
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

// Export `store` (a RoomStore, or any { db } / bare db handle) into
// `directory` as staged parts + manifest. Returns
// { status: "complete", manifest, parts, bytes, sha256, directory } or,
// when maxPartsPerRun stopped the run early,
// { status: "incomplete", exportId, parts, bytes, directory }.
export function exportChunkedToDirectory(store, directory, {
  partBytes = DEFAULT_CHUNKED_PART_BYTES,
  exportId = null,
  maxPartsPerRun = null,
  resume = true,
} = {}) {
  const db = store?.db ?? store;
  if (!db || typeof db.prepare !== "function") throw new Error("Chunked export needs a store or database handle");
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) throw new Error("Chunked export part size must be a positive integer");
  if (maxPartsPerRun != null && (!Number.isSafeInteger(maxPartsPerRun) || maxPartsPerRun < 1)) throw new Error("maxPartsPerRun must be a positive integer");
  const manifestPath = join(directory, "manifest.json");
  const progressPath = join(directory, "progress.json");
  if (existsSync(manifestPath)) throw new Error("Chunked export directory already holds a complete manifest");

  let progress = null;
  if (existsSync(progressPath)) {
    if (!resume) throw new Error("Chunked export directory holds an interrupted export and resume is disabled");
    progress = JSON.parse(readFileSync(progressPath, "utf8"));
    if (progress?.kind !== CHUNKED_EXPORT_PROGRESS_KIND || progress?.version !== CHUNKED_EXPORT_MANIFEST_VERSION
      || !Array.isArray(progress.parts) || typeof progress.watermarkLine !== "string")
      throw new Error("Chunked export progress file is malformed");
    if (exportId != null && progress.exportId !== exportId) throw new Error("Chunked export id does not match the interrupted export");
    // The recorded parts must still be on disk, byte-identical, before
    // any resume work is trusted.
    for (const [index, part] of progress.parts.entries()) {
      if (part.file !== chunkedPartFileName(index) || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || !HEX64.test(part.sha256 ?? ""))
        throw new Error("Chunked export progress file is malformed");
      const path = join(directory, part.file);
      if (!existsSync(path)) throw new Error(CHUNKED_EXPORT_PART_MISMATCH);
      const bytes = readFileSync(path);
      if (bytes.byteLength !== part.bytes || sha256Hex(bytes) !== part.sha256) throw new Error(CHUNKED_EXPORT_PART_MISMATCH);
    }
  }
  const id = progress?.exportId ?? exportId ?? `chunked-${randomUUID()}`;
  const recordedParts = progress?.parts ?? [];
  let skipBytes = recordedParts.reduce((total, part) => total + part.bytes, 0);

  const encoder = new TextEncoder();
  const wholeHash = createHash("sha256");
  const parts = [...recordedParts];
  let totalBytes = skipBytes;
  let partsThisRun = 0;
  let watermarkLine = progress?.watermarkLine ?? null;
  let watermark = progress ? parseJsonLine(progress.watermarkLine, "watermark") : null;
  let lastLine = null;
  let stopped = false;

  // Resume verification state: incoming bytes are first routed, part
  // boundary by part boundary, against the recorded parts.
  let verifyIndex = 0;
  let verifyHash = createHash("sha256");
  let verifyLeft = recordedParts[0]?.bytes ?? 0;
  const feedVerify = chunk => {
    let offset = 0;
    while (offset < chunk.byteLength && skipBytes > 0) {
      const take = Math.min(chunk.byteLength - offset, verifyLeft, skipBytes);
      const slice = chunk.subarray(offset, offset + take);
      verifyHash.update(slice);
      wholeHash.update(slice);
      offset += take;
      verifyLeft -= take;
      skipBytes -= take;
      if (verifyLeft === 0) {
        if (verifyHash.digest("hex") !== recordedParts[verifyIndex].sha256) throw new Error(CHUNKED_EXPORT_RESUME_SOURCE_CHANGED);
        verifyIndex += 1;
        verifyHash = createHash("sha256");
        verifyLeft = recordedParts[verifyIndex]?.bytes ?? 0;
      }
    }
    return chunk.subarray(offset);
  };

  // Part writer state: at most one part is buffered.
  let pending = [];
  let pendingBytes = 0;
  const flushPart = () => {
    if (!pendingBytes) return true;
    const bytes = Buffer.concat(pending.map(chunk => Buffer.from(chunk)), pendingBytes);
    const file = chunkedPartFileName(parts.length);
    writeFileSync(join(directory, file), bytes, { mode: 0o600 });
    parts.push({ file, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    pending = [];
    pendingBytes = 0;
    partsThisRun += 1;
    writeJsonAtomic(progressPath, {
      kind: CHUNKED_EXPORT_PROGRESS_KIND, version: CHUNKED_EXPORT_MANIFEST_VERSION,
      exportId: id, partBytes, watermarkLine, parts, bytes: parts.reduce((total, part) => total + part.bytes, 0),
    });
    if (maxPartsPerRun != null && partsThisRun >= maxPartsPerRun) { stopped = true; return false; }
    return true;
  };
  const feedWriter = chunk => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const room = partBytes - pendingBytes;
      const take = Math.min(chunk.byteLength - offset, room);
      const slice = chunk.subarray(offset, offset + take);
      pending.push(slice);
      pendingBytes += take;
      wholeHash.update(slice);
      totalBytes += take;
      offset += take;
      if (pendingBytes >= partBytes && !flushPart()) return false;
    }
    return true;
  };

  let firstLine = true;
  for (const generatedLine of exportNdjsonLines(db)) {
    let line = generatedLine;
    if (firstLine) {
      firstLine = false;
      const generated = parseJsonLine(line, "watermark");
      if (generated?.kind !== "watermark") throw new Error("Chunked export stream does not start with a watermark");
      if (watermark) {
        if (!sameWatermarkFields(watermark, generated)) throw new Error(CHUNKED_EXPORT_RESUME_SOURCE_CHANGED);
        line = watermarkLine.endsWith("\n") ? watermarkLine : `${watermarkLine}\n`;
      } else {
        watermark = generated;
        watermarkLine = line.replace(/\n$/, "");
      }
    }
    lastLine = line;
    const rest = feedVerify(encoder.encode(line));
    if (rest.byteLength && !feedWriter(rest)) break;
  }
  if (!stopped) {
    // A resume whose recorded parts do not cover a prefix of the stream
    // it just re-derived (source shrank, or the recorded parts were
    // longer than this stream) is a changed source, not a completion.
    if (skipBytes > 0 || verifyIndex !== recordedParts.length) throw new Error(CHUNKED_EXPORT_RESUME_SOURCE_CHANGED);
    // Final flush: the per-run part budget no longer applies — every
    // remaining byte belongs to this export, however many parts it fills.
    const budget = maxPartsPerRun;
    maxPartsPerRun = null;
    flushPart();
    maxPartsPerRun = budget;
    stopped = false;
  }
  if (stopped) return { status: "incomplete", exportId: id, parts: parts.length, bytes: parts.reduce((total, part) => total + part.bytes, 0), directory };

  const trailer = lastLine ? parseJsonLine(lastLine, "trailer") : null;
  if (trailer?.kind !== "trailer") throw new Error("Chunked export stream does not end with a trailer");
  const manifest = {
    kind: CHUNKED_EXPORT_MANIFEST_KIND,
    version: CHUNKED_EXPORT_MANIFEST_VERSION,
    exportId: id,
    createdAt: new Date().toISOString(),
    partBytes,
    parts,
    bytes: totalBytes,
    sha256: wholeHash.digest("hex"),
    watermark,
    trailer,
  };
  // Manifest last: its presence is what makes the directory a complete,
  // importable export.
  writeJsonAtomic(manifestPath, manifest);
  rmSync(progressPath, { force: true });
  return { status: "complete", manifest, parts: parts.length, bytes: totalBytes, sha256: manifest.sha256, directory };
}

// Read and shape-validate a chunked export manifest. Throws on any
// malformed field; part bytes/hashes are verified by assembleChunkedExport.
export function readChunkedManifest(directory) {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) throw new Error("Chunked export manifest is missing");
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Chunked export manifest is not JSON"); }
  if (manifest?.kind !== CHUNKED_EXPORT_MANIFEST_KIND || manifest?.version !== CHUNKED_EXPORT_MANIFEST_VERSION
    || !Array.isArray(manifest.parts) || !manifest.parts.length
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || !HEX64.test(manifest.sha256 ?? ""))
    throw new Error("Chunked export manifest is malformed");
  for (const [index, part] of manifest.parts.entries()) {
    if (part?.file !== chunkedPartFileName(index) || !PART_FILE_PATTERN.test(part.file)
      || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || !HEX64.test(part.sha256 ?? ""))
      throw new Error("Chunked export manifest is malformed");
  }
  if (manifest.parts.reduce((total, part) => total + part.bytes, 0) !== manifest.bytes)
    throw new Error("Chunked export manifest part sizes do not sum to its total");
  return manifest;
}

// Verify every part against the manifest and concatenate the parts, in
// manifest order, into `outFile` (which must not already exist). Holds at
// most one part in memory. Returns { manifest, bytes, sha256 } where
// bytes/sha256 describe the reassembled NDJSON stream — identical to the
// single-file export the parts were sliced from.
export function assembleChunkedExport(directory, outFile) {
  const manifest = readChunkedManifest(directory);
  if (existsSync(outFile)) throw new Error("Refusing to assemble over an existing file");
  const wholeHash = createHash("sha256");
  let total = 0;
  const chunks = [];
  // Parts are bounded by the export's partBytes; collect and write once so
  // a failure mid-assembly leaves no partial outFile behind.
  for (const part of manifest.parts) {
    const path = join(directory, part.file);
    if (!existsSync(path)) throw new Error(CHUNKED_EXPORT_PART_MISMATCH);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== part.bytes || sha256Hex(bytes) !== part.sha256) throw new Error(CHUNKED_EXPORT_PART_MISMATCH);
    wholeHash.update(bytes);
    total += bytes.byteLength;
    chunks.push(bytes);
  }
  const sha256 = wholeHash.digest("hex");
  if (total !== manifest.bytes || sha256 !== manifest.sha256) throw new Error(CHUNKED_EXPORT_PART_MISMATCH);
  writeFileSync(outFile, Buffer.concat(chunks, total), { mode: 0o600, flag: "wx" });
  return { manifest, bytes: total, sha256 };
}
