// PERF-10X CALL 1 (BUILD-BACKUPZIP): gzip transport for the daily KV
// backup + the per-table byte tally in the export trailer.
//
// (a) round-trip: a shaped store exported and written to KV compressed
//     restores through the KV-native endpoint verified "full"; the
//     decompressed transport is byte-equal to the original export and
//     the restored store's data is row-equal (assertRestoredEqual).
// (b) size: on a shaped text-heavy store the stored (compressed) backup
//     is at most ~1/3 of the raw NDJSON (09a-census measured 6.07x on a
//     text-dominated store as an upper bound, 3.5-5x realistic).
// (c) legacy: a version 2 manifest (no compression field, raw parts)
//     still restores, through both the endpoint and the operator script.
// (d) trailer tally: the trailer's byteTally sums to the exported byte
//     total and matches an independent per-table census of the same
//     export (the census-backup.mjs method from 09a-census).
// Unknown or mismatched compression formats are refused fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText, replayNdjson, REPLAY_SKIPPED_TABLES } from "../server/room-export.mjs";
import { operatorRestoreFromBackupResponse } from "../server/restore-ndjson.mjs";
import {
  BACKUP_MANIFEST_VERSION, backupCompressionOf, backupPartKey, gunzipByteChunks, writeKvBackup
} from "../cloudflare/room-backup.mjs";
import { assembleKvBackup } from "../scripts/restore-room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR_TOKEN = "<MASKED_SECRET_001>";
const KEY = "room-backups/2026-10-16.ndjson";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Deterministic word-bank text (the 09a H2 profile): varied prose-like
// bodies, not identical repeated strings, so the compression ratio is
// the text family's, not a degenerate one.
const WORDS = ("deploy release review claim receipt escrow verify agent room message channel member invite backup restore queue landing merge commit branch test coverage index projection event command proof audit trail session token scope budget sprint design schema migration worker durable object sqlite storage latency throughput cache fetch parse render client server gateway protocol handoff approval evidence artifact summary finding blocker risk cost time owner human").split(" ");
// Half the words are syllable-composed pseudo-words: a pure word-bank
// body compresses ~13x (measured), which would flatter the fixture;
// the mix lands the shaped store in 09a's realistic text family.
const SYLLABLES = ("ba cor del fen gar hol in jar kel lum mor nan op par quel rin sol tar um vel win xar yen zor ath ek il om un dar fel gim hak jel kov lur mim nor pel qur rav sel tiv ulm var wel xin yor zav bel cun dov erf fal gil han jor kip lev mun nol per qin ral sur tek ulv vor wen xal yor zin").split(" ");
function pseudoWord(rnd) {
  const count = 2 + Math.floor(rnd() * 3);
  let word = "";
  for (let k = 0; k < count; k += 1) word += SYLLABLES[Math.floor(rnd() * SYLLABLES.length)];
  return word;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function openStore(t, name, seedMessages = 0, { bare = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), name));
  // Simulated clock advancing 30 s per command, as in the 09a H2 build:
  // posting hundreds of messages in real time trips the flood guard.
  let clock = Date.UTC(2026, 8, 1);
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => (clock += 30_000) });
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  // A restore target must be a bare store (schema only, no rooms row):
  // restore is fail-closed into a non-empty store.
  if (bare) return { directory, store };
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  if (seedMessages > 0) {
    store.command(key, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: "agent", displayName: "Backup agent", kind: "agent", permissions: ["accept_work"] } });
    const rnd = mulberry32(20261016);
    for (let i = 0; i < seedMessages; i += 1) {
      const words = [];
      const count = 40 + Math.floor(rnd() * 70);
      for (let k = 0; k < count; k += 1) words.push(rnd() < 0.5 ? WORDS[Math.floor(rnd() * WORDS.length)] : pseudoWord(rnd));
      store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
        data: { messageId: `m-${i}`, body: `note ${i}: ${words.join(" ")}` } });
    }
  }
  return { directory, store };
}

// Same storage contract as the fakes in tests/restore-from-backup.test.js.
function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, typeof value === "string" ? Buffer.from(value) : Buffer.from(value)); },
    async delete(key) { map.delete(key); },
  };
}

function fakeRequest({ key = KEY } = {}) {
  const headers = new Headers({ authorization: `Bearer ${OPERATOR_TOKEN}` });
  const url = "https://room.example/api/operator/restore-from-backup" + (key ? `?key=${encodeURIComponent(key)}` : "");
  return { method: "POST", url, headers, text: async () => "" };
}

// A legacy (pre-gzip) KV backup, written the way the version 2 writer
// wrote it: raw NDJSON parts and a manifest with no compression field.
async function writeLegacyKvBackup(kv, key, ndjsonText, { partBytes = 4096 } = {}) {
  const bytes = Buffer.from(ndjsonText);
  const parts = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += partBytes, index += 1) {
    const part = bytes.subarray(offset, Math.min(offset + partBytes, bytes.byteLength));
    const partKey = backupPartKey(key, index);
    await kv.put(partKey, part);
    parts.push({ key: partKey, bytes: part.byteLength, sha256: sha256(part) });
  }
  const manifest = { kind: "room-backup-manifest", version: 2, key, createdAt: new Date().toISOString(), bytes: bytes.byteLength, sha256: sha256(bytes), parts };
  await kv.put(key, JSON.stringify(manifest));
  return manifest;
}

// A ReadableStream carrying exactly `text`, so a backup can be written
// from the stream shape (the production shape) while the assertions
// below compare against the very bytes that were streamed.
function streamOf(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); }
  });
}

// Restored-store equality, stated the way this repo's round-trip tests
// state it: a full re-export can NOT be byte-equal, by design — secret
// columns are hashed at export, so a restored store (which holds the
// hashes) re-exports them hashed twice, and restores recover data,
// never credentials (docs/BACKUP-DR.md). What must be equal is: the
// room state, every non-skipped table's row count (pinned by the
// original trailer's tally), and the full row dumps of the load-bearing
// secret-free tables.
function assertRestoredEqual(source, target, originalText) {
  assert.deepEqual(target.room("commons"), source.room("commons"));
  const trailer = JSON.parse(originalText.trim().split("\n").at(-1));
  for (const [table, entry] of Object.entries(trailer.byteTally.tables)) {
    if (REPLAY_SKIPPED_TABLES.includes(table)) continue;
    assert.equal(target.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n, entry.rows, `restored row count for ${table}`);
  }
  for (const table of ["events", "messages", "commands", "member_accounts"]) {
    const dump = store => JSON.stringify(store.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
    assert.equal(dump(target), dump(source), `restored rows for ${table}`);
  }
}

test("(a) a gzip KV backup restores verified full and the restored store is row-equal", async t => {
  const { store } = openStore(t, "backup-gzip-roundtrip-", 250);
  const originalText = exportNdjsonText(store.db);
  const events = store.db.prepare("SELECT count(*) AS n FROM events").get().n;

  const kv = fakeKv();
  const started = performance.now();
  const manifest = await writeKvBackup(kv, KEY, streamOf(originalText), { partBytes: 4096 });
  const writeMs = performance.now() - started;
  assert.equal(manifest.version, BACKUP_MANIFEST_VERSION);
  assert.equal(manifest.compression, "gzip");
  assert.ok(manifest.parts.length > 3, "the compressed backup is genuinely parted");
  assert.ok(manifest.parts.every(part => part.bytes <= 4096));
  // The stored parts are one gzip stream of exactly the exported NDJSON.
  const stored = Buffer.concat(manifest.parts.map(part => kv.map.get(part.key)));
  assert.equal(stored.byteLength, manifest.bytes);
  assert.equal(sha256(stored), manifest.sha256);
  assert.equal(manifest.uncompressedSha256, sha256(Buffer.from(originalText)));
  assert.equal(gunzipSync(stored).toString("utf8"), originalText, "decompressed transport is the NDJSON byte for byte");

  const target = openStore(t, "backup-gzip-roundtrip-target-", 0, { bare: true }).store;
  const restoreStarted = performance.now();
  const response = await operatorRestoreFromBackupResponse(fakeRequest(), OPERATOR_TOKEN, target, kv);
  const gzipRestoreMs = performance.now() - restoreStarted;
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.contentVerification, "full", "gzip restore verifies at the same level as a raw restore");
  assert.equal(payload.events, events);
  assert.equal(payload.compression, "gzip");
  assert.equal(payload.bytes, manifest.bytes);
  assert.equal(payload.uncompressedBytes, manifest.uncompressedBytes);

  // Byte-/row-equal at the layers where equality is defined: the
  // transport bytes were proven byte-equal above (gunzip of the parts
  // is the original export), and the restored store's data is equal by
  // assertRestoredEqual (room state, tally row counts, secret-free
  // table dumps — see its comment for why a re-export cannot be the
  // equality proof for secret columns).
  assertRestoredEqual(store, target, originalText);

  // Restore-time guard: the same store restored from a legacy raw backup
  // must be in the same time family (diagnostics; the assertion is only
  // that gzip did not blow up the restore — both are dominated by the
  // recovery audit's event replay).
  const legacyKv = fakeKv();
  await writeLegacyKvBackup(legacyKv, KEY, originalText, { partBytes: 4096 });
  const legacyTarget = openStore(t, "backup-gzip-roundtrip-legacy-", 0, { bare: true }).store;
  const legacyStarted = performance.now();
  const legacyResponse = await operatorRestoreFromBackupResponse(fakeRequest(), OPERATOR_TOKEN, legacyTarget, legacyKv);
  const legacyRestoreMs = performance.now() - legacyStarted;
  assert.equal(legacyResponse.status, 200);
  t.diagnostic(JSON.stringify({ rawBytes: manifest.uncompressedBytes, storedBytes: manifest.bytes, writeMs: Math.round(writeMs), gzipRestoreMs: Math.round(gzipRestoreMs), legacyRestoreMs: Math.round(legacyRestoreMs) }));
  assert.ok(gzipRestoreMs < legacyRestoreMs * 5 + 5000, `gzip restore ${Math.round(gzipRestoreMs)}ms vs legacy ${Math.round(legacyRestoreMs)}ms`);
});

test("(b) a text-heavy shaped store compresses to at most a third of the raw NDJSON", async t => {
  const { store } = openStore(t, "backup-gzip-size-", 250);
  const text = exportNdjsonText(store.db);
  const kv = fakeKv();
  const manifest = await writeKvBackup(kv, KEY, text, { partBytes: 16 * 1024 });
  assert.equal(manifest.uncompressedBytes, Buffer.byteLength(text));
  const ratio = manifest.uncompressedBytes / manifest.bytes;
  t.diagnostic(JSON.stringify({ rawBytes: manifest.uncompressedBytes, storedBytes: manifest.bytes, ratio: Number(ratio.toFixed(2)) }));
  assert.ok(manifest.bytes <= manifest.uncompressedBytes / 3, `stored ${manifest.bytes} bytes is <= 1/3 of raw ${manifest.uncompressedBytes} (ratio ${ratio.toFixed(2)}x)`);
});

test("(c) a legacy uncompressed KV backup (manifest version 2) still restores", async t => {
  const { store } = openStore(t, "backup-gzip-legacy-", 25);
  const text = exportNdjsonText(store.db);
  const kv = fakeKv();
  const manifest = await writeLegacyKvBackup(kv, KEY, text, { partBytes: 2048 });
  assert.equal(manifest.version, 2);
  assert.equal(backupCompressionOf(manifest), "none");
  // The operator script reassembles it unchanged.
  const get = key => kv.map.get(key);
  assert.equal(assembleKvBackup(get(KEY), get).ndjson, text);
  // And the KV-native endpoint restores it, verified full.
  const target = openStore(t, "backup-gzip-legacy-target-", 0, { bare: true }).store;
  const response = await operatorRestoreFromBackupResponse(fakeRequest(), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.contentVerification, "full");
  assert.equal(payload.compression, "none");
  assert.equal(payload.bytes, manifest.bytes);
  assertRestoredEqual(store, target, text);
});

test("(d) the trailer byte tally sums to the exported total and matches an independent census", async t => {
  const { store } = openStore(t, "backup-gzip-tally-", 60);
  const text = exportNdjsonText(store.db);
  const lines = text.split("\n").filter(line => line.trim());
  const trailerLine = lines.at(-1);
  const trailer = JSON.parse(trailerLine);
  assert.ok(trailer.byteTally, "the trailer carries the byte tally");
  const { totalBytes, watermarkBytes, tables } = trailer.byteTally;

  // Independent census of the same export, the 09a census-backup.mjs
  // method: parse each line, bucket its exact byte length by table.
  const census = new Map();
  let censusWatermark = 0;
  for (const line of lines.slice(0, -1)) {
    const bytes = Buffer.byteLength(line) + 1; // the line's "\n"
    const record = JSON.parse(line);
    if (record.kind === "watermark") { censusWatermark += bytes; continue; }
    const entry = census.get(record.table) ?? { rows: 0, bytes: 0 };
    entry.rows += 1;
    entry.bytes += bytes;
    census.set(record.table, entry);
  }
  assert.equal(watermarkBytes, censusWatermark);
  assert.deepEqual(Object.keys(tables).sort(), [...census.keys()].sort(), "the tally covers exactly the exported tables");
  for (const [table, entry] of census) assert.deepEqual(tables[table], entry, `tally for ${table}`);
  // The tally sums to the exported byte total: every line except the
  // trailer itself (which carries the tally), plus the trailer line,
  // is exactly the whole export.
  const summed = watermarkBytes + Object.values(tables).reduce((sum, entry) => sum + entry.bytes, 0);
  assert.equal(summed, totalBytes);
  assert.equal(totalBytes + Buffer.byteLength(trailerLine) + 1, Buffer.byteLength(text));
  // And the tally's row counts agree with the trailer's content digests.
  for (const [table, entry] of Object.entries(tables)) {
    if (trailer.tables[table]) assert.equal(entry.rows, trailer.tables[table].rows, `rows for ${table}`);
  }
});

test("unknown or mismatched compression formats are refused fail-closed", async t => {
  const { store } = openStore(t, "backup-gzip-formats-", 10);
  const text = exportNdjsonText(store.db);

  // Unknown declared format: refused before any replay.
  assert.throws(() => backupCompressionOf({ version: 3, compression: "zstd" }), /unknown compression format/);
  assert.throws(() => backupCompressionOf({ version: 3 }), /does not declare a compression format/);
  const kv = fakeKv();
  const manifest = await writeKvBackup(kv, KEY, text, { partBytes: 2048 });
  kv.map.set(KEY, Buffer.from(JSON.stringify({ ...manifest, compression: "zstd" })));
  const target = openStore(t, "backup-gzip-formats-target-", 0, { bare: true }).store;
  const refused = await operatorRestoreFromBackupResponse(fakeRequest(), OPERATOR_TOKEN, target, kv);
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error.code, "invalid_restore");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");

  // Declared gzip but the parts are raw NDJSON: refused on the magic
  // check, with a manifest that otherwise verifies (stored hashes were
  // recomputed over the raw parts by the legacy-shaped fixture below).
  const rawKv = fakeKv();
  const rawBytes = Buffer.from(text);
  const parts = [];
  for (let offset = 0, index = 0; offset < rawBytes.byteLength; offset += 2048, index += 1) {
    const part = rawBytes.subarray(offset, Math.min(offset + 2048, rawBytes.byteLength));
    const partKey = backupPartKey(KEY, index);
    await rawKv.put(partKey, part);
    parts.push({ key: partKey, bytes: part.byteLength, sha256: sha256(part) });
  }
  await rawKv.put(KEY, JSON.stringify({
    kind: "room-backup-manifest", version: 3, key: KEY, createdAt: new Date().toISOString(), compression: "gzip",
    bytes: rawBytes.byteLength, sha256: sha256(rawBytes),
    uncompressedBytes: rawBytes.byteLength, uncompressedSha256: sha256(rawBytes), parts
  }));
  const rawTarget = openStore(t, "backup-gzip-formats-raw-", 0, { bare: true }).store;
  const rawRefused = await operatorRestoreFromBackupResponse(fakeRequest(), OPERATOR_TOKEN, rawTarget, rawKv);
  assert.equal(rawRefused.status, 422);
  assert.equal((await rawRefused.json()).error.code, "restore_verification_failed");
  assert.equal(rawTarget.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);

  // The operator script refuses the same unknown format.
  assert.throws(() => assembleKvBackup(Buffer.from(JSON.stringify({ ...manifest, compression: "zstd" })), key => kv.map.get(key)), /unknown compression format/);
});

test("a trailer whose byte tally does not sum is malformed and refused at replay", async t => {
  const { directory, store } = openStore(t, "backup-gzip-badtally-", 5);
  const text = exportNdjsonText(store.db);
  const lines = text.split("\n");
  const index = lines.findIndex(line => line.includes('"kind":"trailer"'));
  const trailer = JSON.parse(lines[index]);
  trailer.byteTally.totalBytes += 1;
  lines[index] = JSON.stringify(trailer);
  assert.throws(() => replayNdjson(lines.join("\n"), join(directory, "restored.sqlite")), /trailer is malformed/);
  // The un-tampered export still replays (the tally is metadata, but a
  // well-formed one must not change restore semantics).
  const ok = replayNdjson(text, join(directory, "clean.sqlite"));
  assert.equal(ok.verified, true);
  assert.equal(ok.contentVerification, "full");
});

test("gunzipByteChunks refuses a truncated gzip stream", async t => {
  const kv = fakeKv();
  const { store } = openStore(t, "backup-gzip-truncated-", 20);
  const manifest = await writeKvBackup(kv, KEY, exportNdjsonText(store.db), { partBytes: 1024 });
  const stored = Buffer.concat(manifest.parts.map(part => kv.map.get(part.key)));
  const truncated = stored.subarray(0, stored.byteLength - 10);
  await assert.rejects(async () => {
    for await (const _chunk of gunzipByteChunks([truncated])) { /* drain */ }
  }, error => /gzip|unexpected end|incorrect/i.test(`${error?.message ?? error} ${error?.cause?.message ?? ""}`));
});
