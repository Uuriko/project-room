import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream, exportNdjsonText } from "../server/room-export.mjs";
import { writeDailyBackup, writeKvBackup, backupTarget } from "../cloudflare/room-backup.mjs";
import { assembleKvBackup, summarizeRoom } from "../scripts/restore-room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const restoreScript = fileURLToPath(new URL("../scripts/restore-room-backup.mjs", import.meta.url));

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key).value : null; },
    async put(key, value, options) {
      const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      map.set(key, { value: bytes, options });
    }
  };
}

function openStore(t, messages = 5) {
  const directory = mkdtempSync(join(tmpdir(), "room-backup-kv-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < messages; i += 1) {
    store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m-${i}`, body: `message ${i} ${"x".repeat(300)}` } });
  }
  return { directory, store };
}

test("the KV target is used only when R2 is absent", () => {
  assert.equal(backupTarget({}), null);
  assert.equal(backupTarget({ ROOM_BACKUPS_KV: fakeKv() }), "kv");
  assert.equal(backupTarget({ ROOM_BACKUPS_KV: fakeKv(), ROOM_BACKUPS: { put() {}, head() {} } }), "r2");
  assert.throws(() => backupTarget({ ROOM_BACKUPS_KV: {} }), /put or get/);
});

test("the daily KV backup writes parts then a manifest, once a day, with a TTL", async t => {
  const { store } = openStore(t);
  const kv = fakeKv();
  const room = { exportRoomNdjson: () => exportNdjsonStream(store.db) };
  const when = new Date(Date.UTC(2026, 9, 8, 9));
  const wrote = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, when);
  assert.equal(wrote.wrote, "room-backups/2026-10-08.ndjson");
  assert.equal(wrote.target, "kv");
  const manifest = JSON.parse(kv.map.get("room-backups/2026-10-08.ndjson").value.toString());
  assert.equal(manifest.kind, "room-backup-manifest");
  assert.equal(manifest.parts.length, wrote.parts);
  for (const { options } of kv.map.values()) assert.equal(options.expirationTtl, 35 * 24 * 60 * 60);
  const again = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, { exportRoomNdjson: () => { throw new Error("must not export twice"); } }, when);
  assert.deepEqual(again, { skipped: "exists", key: "room-backups/2026-10-08.ndjson", target: "kv" });
});

test("a KV backup split into many parts reassembles byte-equal, replays, and catches tampering", async t => {
  const { directory, store } = openStore(t, 12);
  const kv = fakeKv();
  const text = exportNdjsonText(store.db);
  const manifest = await writeKvBackup(kv, "room-backups/2026-10-08.ndjson", exportNdjsonStream(store.db), { partBytes: 1000 });
  assert.ok(manifest.parts.length > 3, "expected several parts");
  assert.ok(manifest.parts.every(part => part.bytes <= 1000));
  const get = key => kv.map.get(key).value;
  const { ndjson } = assembleKvBackup(get(manifest.key), get);
  assert.equal(ndjson.replace(/"backedUpAt":\d+/, ""), text.replace(/"backedUpAt":\d+/, ""));

  const file = join(directory, "backup.ndjson");
  writeFileSync(file, ndjson, { mode: 0o600 });
  const target = join(directory, "restore", "room.sqlite");
  const out = JSON.parse(execFileSync(process.execPath, [restoreScript, "--from", file, "--to", target, "--room", "commons"], { encoding: "utf8" }));
  assert.equal(out.verified, true);
  const live = summarizeRoom(join(directory, "live.sqlite"), "commons");
  assert.deepEqual(out.rooms[0], live);
  assert.equal(out.rooms[0].messages, 12);

  assert.throws(() => execFileSync(process.execPath, [restoreScript, "--from", file, "--to", target], { encoding: "utf8", stdio: "pipe" }), /existing file/);
  const tampered = Buffer.from(get(manifest.parts[1].key));
  tampered[0] ^= 1;
  assert.throws(() => assembleKvBackup(get(manifest.key), key => key === manifest.parts[1].key ? tampered : get(key)), /does not match its manifest/);
  assert.equal(existsSync(join(directory, "restore", "other.sqlite")), false);
});
