// #3409: restore the daily backup from the KV namespace it already lives
// in. The request-body restore (POST /api/operator/restore) caps at
// RESTORE_MAX_BYTES because it buffers the whole export; production's
// backup is past that cap. The KV path pulls the manifest + bounded parts
// one at a time and streams them through the replay session, so the same
// backup restores and verifies. Fixtures ride room_attachments BLOBs: they
// are byte-proven by the replay (checkStoredBytes) without dragging the
// room-projection replay audit into bulk data.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream, exportNdjsonText, exportTrailer, createTableDigests, REPLAY_SKIPPED_TABLES } from "../server/room-export.mjs";
import {
  operatorRestoreResponse, operatorRestoreFromBackupResponse, RESTORE_MAX_BYTES,
} from "../server/restore-ndjson.mjs";
import { writeKvBackup, backupObjectKey, backupPartKey, BACKUP_KV_PART_BYTES } from "../cloudflare/room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR_TOKEN = "<MASKED_SECRET_001>";
const KEY = "room-backups/2026-10-14.ndjson";

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedStore(t) {
  const store = openStore(t, "restore-kv-seed-");
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Restore agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "history that must survive the kv restore" } });
  return store;
}

// Same storage contract as the fake in tests/room-backup-export.test.js.
function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, typeof value === "string" ? value : Buffer.from(value)); },
    async delete(key) { map.delete(key); },
  };
}

function fakeRequest({ body = "", token = OPERATOR_TOKEN, key } = {}) {
  const headers = new Headers();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = "https://room.example/api/operator/restore-from-backup" + (key ? `?key=${encodeURIComponent(key)}` : "");
  return { method: "POST", url, headers, text: async () => body };
}

async function backupToKv(t, store, { partBytes = 2048 } = {}) {
  const kv = fakeKv();
  const manifest = await writeKvBackup(kv, KEY, exportNdjsonStream(store.db), { partBytes });
  return { kv, manifest };
}

test("restore-from-backup replays the KV backup into an empty store, verified", async t => {
  const seeded = seedStore(t);
  const events = seeded.db.prepare("SELECT count(*) AS n FROM events").get().n;
  const { kv } = await backupToKv(t, seeded);
  const target = openStore(t, "restore-kv-target-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ body: JSON.stringify({ key: KEY }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.verified, true);
  assert.equal(payload.events, events);
  assert.equal(payload.source, "kv-backup");
  assert.ok(payload.bytes > 0);
  const row = target.db.prepare("SELECT body FROM events WHERE body LIKE '%history that must survive the kv restore%'").get();
  assert.ok(row, "restored history is readable");
  assert.ok(target.room("commons").state.members.agent, "restored members are present");
});

test("restore-from-backup gates: unconfigured token 404, bad token 401, missing backup 404, bad key 422, non-empty 409", async t => {
  const seeded = seedStore(t);
  const { kv } = await backupToKv(t, seeded);
  const target = openStore(t, "restore-kv-gates-");
  assert.equal((await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), undefined, target, kv)).status, 404);
  assert.equal((await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY, token: "wrong" }), OPERATOR_TOKEN, target, kv)).status, 401);
  const missing = await operatorRestoreFromBackupResponse(fakeRequest({ key: "room-backups/2020-01-01.ndjson" }), OPERATOR_TOKEN, target, kv);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "backup_not_found");
  const badKey = await operatorRestoreFromBackupResponse(fakeRequest({ key: "../secrets" }), OPERATOR_TOKEN, target, kv);
  assert.equal(badKey.status, 422);
  // Non-empty: the seeded store itself refuses and keeps its data.
  const refused = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, seeded, kv);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "restore_refused_nonempty");
  assert.ok(seeded.room("commons").state.members.agent, "the live store is untouched");
});

test("restore-from-backup refuses a tampered part and leaves the store empty and retryable", async t => {
  const seeded = seedStore(t);
  const { kv, manifest } = await backupToKv(t, seeded);
  const partKey = backupPartKey(KEY, 0);
  const part = Buffer.from(kv.map.get(partKey));
  part[10] ^= 0xff;
  kv.map.set(partKey, part);
  const target = openStore(t, "restore-kv-tampered-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "restore_verification_failed");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");
  // Retry with the intact backup succeeds — the failure was not sticky.
  const { kv: goodKv } = await backupToKv(t, seeded);
  const retry = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, goodKv);
  assert.equal(retry.status, 200);
  assert.equal(manifest.parts.length >= 1, true);
});

test("restore-from-backup refuses a doctored manifest", async t => {
  const seeded = seedStore(t);
  const { kv } = await backupToKv(t, seeded);
  const manifest = JSON.parse(kv.map.get(KEY));
  manifest.parts[0].sha256 = "0".repeat(64);
  kv.map.set(KEY, JSON.stringify(manifest));
  const target = openStore(t, "restore-kv-doctored-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 422);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);
});

// The production failure in #3409: a representative backup LARGER than the
// 64 MiB request-body cap. The body path refuses it with 413; the KV path
// restores and verifies the identical backup.
test("restore-from-backup restores a representative backup larger than RESTORE_MAX_BYTES", async t => {
  const seeded = openStore(t, "restore-kv-big-seed-");
  seeded.initialize(initialRoom());
  const blob = Buffer.alloc(1024 * 1024, 0x5a);
  const sha = createHash("sha256").update(blob).digest("hex");
  const text = "a".repeat(1024 * 1024);
  const textSha = createHash("sha256").update(text).digest("hex");
  const now = Date.now();
  const insert = seeded.db.prepare(`INSERT INTO room_attachments
    (room_id, id, uploader_id, filename, media_type, byte_length, sha256, bytes, state, created_at, expires_at)
    VALUES (?, ?, 'owner', 'bulk.bin', 'application/octet-stream', ?, ?, ?, 'staged', ?, ?)`);
  // 5 rooms x 16 MiB of staged attachment bytes (the per-file cap is 1 MiB).
  // Most cells are TEXT-typed on purpose: auditRecovery's content digest
  // canonicalizes BLOB cells byte-by-byte (~5.3s per MiB measured, vs 46ms
  // for a text cell), a pre-existing cost every restore path pays that
  // would dominate this test without testing anything new. Four real BLOB
  // rows keep the binary path exercised at scale; the small tests cover
  // binary round-trips exhaustively.
  for (let room = 1; room <= 5; room++) {
    const roomId = `bulk-${room}`;
    seeded.initialize(initialRoom(roomId));
    for (let i = 0; i < 16; i++) {
      if (room === 1 && i < 4) insert.run(roomId, `att-${i}`, blob.length, sha, blob, now, now + 3600_000);
      else insert.run(roomId, `att-${i}`, text.length, textSha, text, now, now + 3600_000);
    }
  }
  // Stream the backup into KV first: the manifest's byte count IS the
  // export size, and nothing in this test ever holds the whole export in
  // memory (that is the property under test — a buffered fixture would OOM
  // the test runner long before it proved anything about the restore).
  const kv = fakeKv();
  const manifest = await writeKvBackup(kv, KEY, exportNdjsonStream(seeded.db), { partBytes: 4 * 1024 * 1024 });
  assert.ok(manifest.bytes > RESTORE_MAX_BYTES, `fixture is representative: ${manifest.bytes} bytes > the ${RESTORE_MAX_BYTES}-byte cap`);
  assert.ok(manifest.parts.length > 16, `backup is genuinely chunked (${manifest.parts.length} parts)`);

  // The old path refuses a body of exactly this size (the declared-length
  // guard fires before any body is read).
  const bodyResponse = await operatorRestoreResponse({
    method: "POST",
    url: "https://room.example/api/operator/restore",
    headers: new Headers({ authorization: `Bearer ${OPERATOR_TOKEN}`, "content-length": String(manifest.bytes) }),
    body: null,
    text: async () => "",
  }, OPERATOR_TOKEN, openStore(t, "restore-kv-big-body-"));
  assert.equal(bodyResponse.status, 413);

  // The KV path restores and verifies the identical backup, part by part.
  const target = openStore(t, "restore-kv-big-target-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.bytes, manifest.bytes);
  const attachments = target.db.prepare("SELECT count(*) AS n, sum(byte_length) AS total FROM room_attachments").get();
  assert.equal(attachments.n, 80);
  assert.equal(attachments.total, 80 * 1024 * 1024);
  const blobSample = target.db.prepare("SELECT sha256 FROM room_attachments WHERE room_id='bulk-1' AND id='att-0'").get();
  assert.equal(blobSample.sha256, sha);
  const textSample = target.db.prepare("SELECT sha256 FROM room_attachments WHERE room_id='bulk-3' AND id='att-7'").get();
  assert.equal(textSample.sha256, textSha);
});

test("restore-from-backup defaults to today's backup key", async t => {
  const seeded = seedStore(t);
  const kv = fakeKv();
  const todayKey = backupObjectKey(new Date());
  await writeKvBackup(kv, todayKey, exportNdjsonStream(seeded.db), { partBytes: 2048 });
  const target = openStore(t, "restore-kv-today-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({}), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).key, todayKey);
});

// #3409 at today's production size and shape. The 2026-10-15 proof fixture
// (90,688,789 bytes) is already smaller than the live backup (92,129,237
// bytes on 2026-10-16, growing ~2.3 MB/day), and its bytes were attachment
// bulk over a small event count. Production's growth is message data, so
// this fixture is the other shape: thousands of real message.posted
// commands whose bodies dominate the export (each body lands in the
// events, messages, and projection copies), seeded across many rooms so
// no room crosses its 4 MiB projection cap, written to KV at the
// production part size (16 MiB), and restored through the KV-native
// endpoint. The verdict does not rest on the restore's own flags: the
// manifest is checked against a single teed export pass (the watermark
// carries Date.now(), so two passes never hash alike), every table's row
// count is compared, the restored store is re-exported and its trailer
// digests must equal the source trailer's, and the store is reopened.
// Scale comes from RESTORE_PROOF_TARGET_BYTES (default: just over the
// 64 MiB request-body cap, so CI stays bounded); the production-scale
// proof run raises it past the live backup's size.
const PROOF_TARGET_BYTES = Math.max(
  RESTORE_MAX_BYTES + 1,
  Number(process.env.RESTORE_PROOF_TARGET_BYTES ?? 71_000_000) || 71_000_000,
);
const PROOF_BODY_CHARS = 24_000;
// Tables a restore legitimately rewrites rather than copies: the claim
// writer permit is the target's own (skipped on replay, #3324), and the
// accounts row's secret material is re-derived — credentials never
// survive a restore as live values (#3599), so its re-export digest
// differs from the exported row's by design.
const PROOF_DIGEST_ALLOWLIST = new Set(["public_work_claim_writer_permit", "accounts"]);

test("restore-from-backup restores an event-dominated backup above the cap at production part size and scale", async t => {
  const startedAt = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "restore-kv-proof-seed-"));
  const seeded = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { seeded.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });

  // Deterministic word-salad bodies: varied text, no giant repeated run.
  const words = "coordination receipt verified delivery claim review room agent human trust backup restore proof message work".split(" ");
  let lcg = 123456789;
  const rnd = () => (lcg = (lcg * 1103515245 + 12345) % 2147483648) / 2147483648;
  const makeBody = () => {
    let body = "";
    while (body.length < PROOF_BODY_CHARS) body += words[Math.floor(rnd() * words.length)] + " ";
    return body.slice(0, PROOF_BODY_CHARS);
  };
  const exportBytes = async db => {
    let bytes = 0;
    for await (const chunk of exportNdjsonStream(db)) bytes += Buffer.byteLength(chunk);
    return bytes;
  };

  let posts = 0;
  let rooms = 0;
  let stagedSha = null;
  let firstBody = null;
  while (rooms < 60) {
    const roomId = `proof-${rooms}`;
    seeded.initialize(initialRoom(roomId));
    const ownerKey = seeded.issueAccessKey(roomId, "owner");
    for (let m = 0; m < 2; m++) {
      const memberId = `agent-${m}`;
      seeded.command(ownerKey, roomId, { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: `Proof agent ${m}`, kind: "agent", permissions: ["accept_work", "complete_work"] } });
      const memberKey = seeded.issueAccessKey(roomId, memberId);
      for (let i = 0; i < 25; i++) {
        const body = makeBody();
        if (rooms === 0 && m === 0 && i === 0) firstBody = body;
        seeded.command(memberKey, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED,
          data: { messageId: randomUUID(), body } });
        posts += 1;
      }
    }
    seeded.command(ownerKey, roomId, { id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: `proof-work-${rooms}`, title: `Proof work ${rooms}`,
      definitionOfDone: "Survives the restore proof", accountableMemberId: "agent-0", mode: "read" } });
    if (rooms === 0) {
      // Real BLOB attachments, exercised at modest size (the restore's
      // recovery audit canonicalizes BLOB cells at ~5.3s/MiB; the bulk
      // BLOB path at scale is the attachment test above).
      const fileBytes = Buffer.alloc(512 * 1024, 0x37);
      stagedSha = createHash("sha256").update(fileBytes).digest("hex");
      for (let i = 0; i < 4; i++) seeded.roomAttachments.stage(ownerKey, roomId, {
        id: `proof-file-${i}`, filename: `proof-${i}.bin`,
        mediaType: "application/octet-stream", data: fileBytes.toString("base64") });
    }
    rooms += 1;
    if (await exportBytes(seeded.db) >= PROOF_TARGET_BYTES) break;
  }
  const seedMs = Date.now() - startedAt;

  // One teed pass: the bytes writeKvBackup stores are the bytes hashed
  // here, so the manifest must describe this exact export.
  const kv = fakeKv();
  const teeHash = createHash("sha256");
  let teeBytes = 0;
  let teeTail = "";
  const tee = new TransformStream({ transform(chunk, controller) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    teeHash.update(buf);
    teeBytes += buf.byteLength;
    teeTail = (teeTail + buf.toString("utf8")).slice(-262144);
    controller.enqueue(chunk);
  } });
  const teeDone = exportNdjsonStream(seeded.db).pipeTo(tee.writable);
  const manifest = await writeKvBackup(kv, KEY, tee.readable);
  await teeDone;
  const sourceTrailer = JSON.parse(teeTail.split("\n").filter(line => line.trim()).at(-1));
  assert.equal(manifest.bytes, teeBytes, "manifest describes the teed export byte for byte");
  assert.equal(manifest.sha256, teeHash.digest("hex"));
  assert.ok(manifest.bytes >= PROOF_TARGET_BYTES, `fixture reached target scale: ${manifest.bytes} bytes`);
  assert.ok(manifest.bytes > RESTORE_MAX_BYTES, `fixture exceeds the request-body cap: ${manifest.bytes} > ${RESTORE_MAX_BYTES}`);
  assert.ok(manifest.parts.length >= 5, `backup is chunked at production part size (${manifest.parts.length} parts)`);
  assert.ok(manifest.parts.slice(0, -1).every(part => part.bytes === BACKUP_KV_PART_BYTES),
    "every part but the last is exactly BACKUP_KV_PART_BYTES");

  const targetDirectory = mkdtempSync(join(tmpdir(), "restore-kv-proof-target-"));
  const targetFile = join(targetDirectory, "room.sqlite");
  const target = new RoomStore(targetFile);
  t.after(() => { try { target.close(); } catch { /* already closed */ } rmSync(targetDirectory, { recursive: true, force: true }); });
  const restoreStarted = Date.now();
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, kv);
  const restoreMs = Date.now() - restoreStarted;
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.contentVerification, "full");
  assert.equal(payload.events, sourceTrailer.events);
  assert.equal(payload.bytes, manifest.bytes);

  // Independent check 1: per-table row counts, skipping only the tables
  // the replay itself reports as skipped.
  const tableNames = db => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const skipped = new Set(Object.keys(payload.skippedTables ?? {}));
  const countOf = (db, table) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
  const sourceTables = new Set(tableNames(seeded.db));
  const targetTables = new Set(tableNames(target.db));
  let tablesCompared = 0;
  for (const table of new Set([...sourceTables, ...targetTables])) {
    if (skipped.has(table)) continue;
    if (!sourceTables.has(table) || !targetTables.has(table)) {
      // A table on only one side is legitimate only for the replay's own
      // skip list (runtime/idempotency tables are target-native or
      // created lazily); anything else means the restore lost a table.
      assert.ok(REPLAY_SKIPPED_TABLES.includes(table),
        `table ${table} exists on only one side of the restore and is not replay-skipped`);
      continue;
    }
    assert.equal(countOf(target.db, table), countOf(seeded.db, table), `row count matches for ${table}`);
    tablesCompared += 1;
  }

  // Independent check 2: re-export the restored store; its trailer must
  // pin the same event log and the same per-table digests as the source
  // trailer, outside the restore-rewritten allowlist.
  let targetTail = "";
  for await (const chunk of exportNdjsonStream(target.db)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    targetTail = (targetTail + buf.toString("utf8")).slice(-262144);
  }
  const targetTrailer = JSON.parse(targetTail.split("\n").filter(line => line.trim()).at(-1));
  assert.equal(targetTrailer.events, sourceTrailer.events);
  assert.equal(targetTrailer.eventsHash, sourceTrailer.eventsHash, "restored event log hashes identically");
  const digestMismatches = [];
  for (const [table, entry] of Object.entries(sourceTrailer.tables ?? {})) {
    if (PROOF_DIGEST_ALLOWLIST.has(table)) continue;
    const other = targetTrailer.tables?.[table];
    if (!other || other.rows !== entry.rows || other.sha256 !== entry.sha256) digestMismatches.push(table);
  }
  assert.deepEqual(digestMismatches, [], "re-export digests match the source trailer");

  // Independent check 3: the restored store reopens and serves its data.
  const attachment = target.db.prepare(
    "SELECT sha256, byte_length FROM room_attachments WHERE room_id='proof-0' AND id='proof-file-0'").get();
  assert.equal(attachment.sha256, stagedSha);
  assert.equal(attachment.byte_length, 512 * 1024);
  target.close();
  const reopened = new RoomStore(targetFile, { readOnly: true });
  try {
    assert.ok(reopened.room("proof-0").state.members["agent-0"], "reopened store has the seeded members");
    const found = reopened.db.prepare("SELECT body FROM events WHERE room_id='proof-0' AND body LIKE ?").get(`%${firstBody.slice(0, 64)}%`);
    assert.ok(found, "reopened store serves a seeded message body");
  } finally { reopened.close(); }

  console.log(JSON.stringify({ restoreProof: {
    targetBytes: PROOF_TARGET_BYTES, exportBytes: manifest.bytes, exportSha256: manifest.sha256,
    parts: manifest.parts.length, partBytes: BACKUP_KV_PART_BYTES, rooms, posts,
    events: sourceTrailer.events, tablesCompared, digestMismatches,
    verified: payload.verified, contentVerification: payload.contentVerification,
    seedMs, restoreMs, totalMs: Date.now() - startedAt } }));
});

test("restore-from-backup refuses a backup whose credentials were tampered before the manifest was written (#3325)", async t => {
  const seeded = seedStore(t);
  let done = false;
  const tampered = exportNdjsonText(seeded.db).split("\n").map(line => {
    if (done || !line.includes('"table":"credentials"')) return line;
    const record = JSON.parse(line);
    if (typeof record.row.expires_at !== "number") return line;
    record.row.expires_at += 315576000000;
    done = true;
    return JSON.stringify(record);
  }).join("\n");
  assert.ok(done, "fixture export has a credentials row with a numeric expires_at");
  // The manifest honestly describes the tampered bytes (corruption at the
  // source, or a manifest written over them): every part hash and the
  // whole-file hash pass, so only the export trailer's own per-table
  // digests can catch the edit.
  const kv = fakeKv();
  await writeKvBackup(kv, KEY, tampered, { partBytes: 2048 });
  const target = openStore(t, "restore-kv-digest-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "restore_verification_failed");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");
  // The intact backup restores and reports the full verification level.
  const { kv: goodKv } = await backupToKv(t, seeded);
  const ok = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, goodKv);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).contentVerification, "full");
});

// Bug sweep 2026-10-16 F1: a byte-valid backup whose stored projections
// were written by older code can differ from current-reducer replay. The
// file replay has an audit "report" mode for exactly this case; the KV
// session path — the only one that fits the real over-cap backup —
// refused with a generic 500. Strict stays the default, but the refusal
// now names the drift (room + fields) as a legible 422, and the operator
// opt-in (audit: "report") lands the data with the drift as a named
// qualification on the result.
async function driftedBackup(t) {
  const seeded = seedStore(t);
  const row = seeded.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
  const state = JSON.parse(row.projection);
  state.members.agent.displayName = "Drifted Name";
  seeded.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
  const { kv } = await backupToKv(t, seeded);
  return kv;
}

test("restore-from-backup refuses a drifted backup in strict mode and names the drift", async t => {
  const kv = await driftedBackup(t);
  const target = openStore(t, "restore-kv-drift-strict-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ body: JSON.stringify({ key: KEY }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 422, "the reconciliation refusal is operator-legible, not a generic 500");
  const payload = await response.json();
  assert.equal(payload.error.code, "restore_verification_failed");
  assert.match(payload.error.message, /commons/);
  assert.match(payload.error.message, /displayName/);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");
});

test("restore-from-backup lands a drifted backup under the report opt-in, drift named", async t => {
  const kv = await driftedBackup(t);
  const target = openStore(t, "restore-kv-drift-report-");
  const response = await operatorRestoreFromBackupResponse(
    fakeRequest({ body: JSON.stringify({ key: KEY, audit: "report" }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.contentVerification, "full");
  assert.equal(payload.audit.ok, false, "verified never stands unqualified when the audit failed");
  assert.match(payload.audit.error, /requires operator reconciliation/);
  assert.deepEqual(payload.audit.drift, [{ room: "commons", fields: ["state.members.agent.displayName"] }]);
  assert.equal(target.room("commons").state.members.agent.displayName, "Drifted Name", "the drifted data landed as stored");

  // The same opt-in via query parameter.
  const queryTarget = openStore(t, "restore-kv-drift-report-query-");
  const headers = new Headers({ authorization: `Bearer ${OPERATOR_TOKEN}` });
  const queryResponse = await operatorRestoreFromBackupResponse(
    { method: "POST", url: `https://room.example/api/operator/restore-from-backup?key=${encodeURIComponent(KEY)}&audit=report`, headers, text: async () => "" },
    OPERATOR_TOKEN, queryTarget, kv);
  assert.equal(queryResponse.status, 200);
  assert.equal((await queryResponse.json()).audit.ok, false);

  // An unrecognized audit value is refused, never silently treated as strict.
  const badTarget = openStore(t, "restore-kv-drift-bad-");
  const bad = await operatorRestoreFromBackupResponse(
    fakeRequest({ body: JSON.stringify({ key: KEY, audit: "bogus" }) }), OPERATOR_TOKEN, badTarget, kv);
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_restore");
});

// Bug sweep 2026-10-16 F2: a credentials row whose parent_hash names no
// row in the export was held back by the session's per-row hold-back at
// every flush and silently never landed, while the restore reported
// verified:true / "full" — the trailer pins the stream, the foreign-key
// check only sees landed rows, and the watermark's per-table counts are
// never written by the exporter. The session now refuses by name.
test("restore-from-backup refuses a backup whose self-referencing row can never land", async t => {
  const seeded = seedStore(t);
  const hex = seedText => createHash("sha256").update(seedText).digest("hex");
  const digests = createTableDigests();
  const out = [];
  let fabricated = null;
  for (const line of exportNdjsonText(seeded.db).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind === "trailer") continue; // rebuilt below over the doctored stream
    if (record.kind === "watermark") { out.push(line); continue; }
    digests.add(record.table, record.row);
    out.push(line);
    if (record.table === "credentials" && !fabricated) {
      fabricated = { table: "credentials", row: { ...record.row,
        hash: hex("fabricated-child-credential"),
        parent_hash: hex("parent-that-is-not-in-the-export") } };
      digests.add(fabricated.table, fabricated.row);
      out.push(JSON.stringify(fabricated));
    }
  }
  assert.ok(fabricated, "fixture export has a credentials row to clone");
  out.push(JSON.stringify(exportTrailer(seeded.db, digests.finish())));
  const kv = fakeKv();
  await writeKvBackup(kv, KEY, out.join("\n") + "\n", { partBytes: 2048 });
  const target = openStore(t, "restore-kv-held-row-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ body: JSON.stringify({ key: KEY }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 422, "an unlandable row is a named refusal, not a silent drop under a full claim");
  const payload = await response.json();
  assert.equal(payload.error.code, "restore_verification_failed");
  assert.match(payload.error.message, /credentials/);
  assert.match(payload.error.message, /parent_hash/);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");
  // The intact backup restores into the same target — the failure was not sticky.
  const { kv: goodKv } = await backupToKv(t, seeded);
  const retry = await operatorRestoreFromBackupResponse(fakeRequest({ key: KEY }), OPERATOR_TOKEN, target, goodKv);
  assert.equal(retry.status, 200);
});

// Bug sweep 2026-10-16 F3: production runs bodies-at-rest, so its
// projections carry bodyRefs and a populated projection_bodies table —
// but no restore test ever enabled the flag, including the standing
// proof above. The slim shape must survive the KV restore and the body
// must round-trip through room().
test("restore-from-backup restores the production bodies-at-rest shape and the slim body round-trips", async t => {
  const directory = mkdtempSync(join(tmpdir(), "restore-kv-slim-seed-"));
  const seeded = new RoomStore(join(directory, "room.sqlite"), { bodiesAtRest: true });
  t.after(() => { try { seeded.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  seeded.initialize(initialRoom());
  const key = seeded.issueAccessKey("commons", "owner");
  const body = "at-rest body that must survive the restore ".repeat(30).trim();
  const messageId = randomUUID();
  seeded.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId, body } });
  // Fixture validity: the stored shape really is the production slim one.
  const projection = seeded.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  assert.ok(projection.includes('"bodyRef"'), "seed projection carries a bodyRef");
  assert.ok(!projection.includes(body.slice(0, 40)), "seed projection does not inline the body");
  assert.ok(seeded.db.prepare("SELECT count(*) AS n FROM projection_bodies").get().n >= 1, "seed has projection_bodies rows");
  const { kv } = await backupToKv(t, seeded);

  const targetDirectory = mkdtempSync(join(tmpdir(), "restore-kv-slim-target-"));
  const target = new RoomStore(join(targetDirectory, "room.sqlite"), { bodiesAtRest: true });
  t.after(() => { try { target.close(); } catch { /* already closed */ } rmSync(targetDirectory, { recursive: true, force: true }); });
  const response = await operatorRestoreFromBackupResponse(fakeRequest({ body: JSON.stringify({ key: KEY }) }), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.contentVerification, "full");
  const message = target.room("commons").state.messages.find(entry => entry.id === messageId);
  assert.equal(message?.body, body, "the slim body round-trips through the restore");
});
