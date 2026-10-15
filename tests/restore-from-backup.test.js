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
import { exportNdjsonStream } from "../server/room-export.mjs";
import {
  operatorRestoreResponse, operatorRestoreFromBackupResponse, RESTORE_MAX_BYTES,
} from "../server/restore-ndjson.mjs";
import { writeKvBackup, backupObjectKey, backupPartKey } from "../cloudflare/room-backup.mjs";
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
