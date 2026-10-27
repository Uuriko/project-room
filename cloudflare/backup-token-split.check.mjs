// TM-2: the backup doors no longer share one credential. ROOM_EXPORT_TOKEN
// opens GET /api/operator/export only; ROOM_RESTORE_TOKEN opens the two
// restore doors only and stays unset outside a restore incident, so they
// answer 404 in normal operation. The retired ROOM_BACKUP_TOKEN opens
// nothing, and configuring both new secrets to the same value voids the
// split: both doors fail closed (404) until the values differ.
// Workerd proof on the real Durable Object, one Miniflare per configuration.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream, exportNdjsonText } from "../server/room-export.mjs";
import { writeKvBackup } from "./room-backup.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(join(here, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");

const origin = "https://room.example.test";
const EXPORT_TOKEN = "export-token-value-0123456789";
const RESTORE_TOKEN = "restore-token-value-0123456789";
const SHARED_TOKEN = "one-value-in-both-secrets-0123456789";
const LEGACY_TOKEN = "legacy-backup-token-value-0123456789";

const bundled = await build({
  entryPoints: [join(here, "room.mjs")],
  bundle: true, write: false, format: "esm", platform: "neutral",
  external: ["node:*", "cloudflare:*"]
});

async function boot(bindings) {
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "ProjectRoom", useSQLite: true } },
    kvNamespaces: ["ROOM_BACKUPS_KV"],
    bindings: { ROOM_ORIGIN: origin, ...bindings }
  });
  const call = (path, { method = "GET", token, body } = {}) => mf.dispatchFetch(origin + path, {
    method,
    headers: {
      "CF-Connecting-IP": "192.0.2.10",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": path.endsWith("restore") ? "application/x-ndjson" : "application/json" } : {})
    },
    ...(body ? { body } : {})
  });
  return { mf, call };
}

// A valid whole-store export carrying one room, built on the Node side the
// same way restore-fk-order.check.mjs builds its fixtures. The export
// stream is lazy, so the seed store stays open until cleanup() runs.
async function seedStore() {
  const directory = await mkdtemp(join(tmpdir(), "backup-token-split-"));
  const seed = new RoomStore(join(directory, "seed.sqlite"));
  seed.initialize(initialRoom());
  return {
    db: seed.db,
    cleanup: async () => {
      seed.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("the export token opens the export door and nothing else", { timeout: 120000 }, async () => {
  const { mf, call } = await boot({ ROOM_EXPORT_TOKEN: EXPORT_TOKEN });
  try {
    const ok = await call("/api/operator/export", { token: EXPORT_TOKEN });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.match(ok.headers.get("content-type") ?? "", /application\/x-ndjson/);
    assert.match(await ok.text(), /"kind":"watermark"/);
    // The read credential is refused at both restore doors: with no restore
    // token configured they do not exist (404), whatever is presented.
    const restore = await call("/api/operator/restore", { method: "POST", token: EXPORT_TOKEN, body: "{}\n" });
    assert.equal(restore.status, 404);
    const fromBackup = await call("/api/operator/restore-from-backup", { method: "POST", token: EXPORT_TOKEN, body: "{}" });
    assert.equal(fromBackup.status, 404);
  } finally {
    await mf.dispose();
  }
});

test("the restore token opens both restore doors and not the export door", { timeout: 120000 }, async () => {
  const seed = await seedStore();
  try {
    const text = exportNdjsonText(seed.db);
    const bodyBoot = await boot({ ROOM_RESTORE_TOKEN: RESTORE_TOKEN });
    try {
      const closed = await bodyBoot.call("/api/operator/export", { token: RESTORE_TOKEN });
      assert.equal(closed.status, 404);
      const restored = await bodyBoot.call("/api/operator/restore", { method: "POST", token: RESTORE_TOKEN, body: text });
      const result = await restored.json();
      assert.equal(restored.status, 200, JSON.stringify(result));
      assert.equal(result.ok, true);
      assert.equal(result.verified, true);
    } finally {
      await bodyBoot.mf.dispose();
    }

    const kvBoot = await boot({ ROOM_RESTORE_TOKEN: RESTORE_TOKEN });
    try {
      const kv = await kvBoot.mf.getKVNamespace("ROOM_BACKUPS_KV");
      const key = "room-backups/2026-10-15.ndjson";
      await writeKvBackup(kv, key, exportNdjsonStream(seed.db), { partBytes: 16384 });
      const restored = await kvBoot.call("/api/operator/restore-from-backup", { method: "POST", token: RESTORE_TOKEN, body: JSON.stringify({ key }) });
      const result = await restored.json();
      assert.equal(restored.status, 200, JSON.stringify(result));
      assert.equal(result.verified, true);
    } finally {
      await kvBoot.mf.dispose();
    }
  } finally {
    await seed.cleanup();
  }
});

test("with both tokens configured, each is refused at the other's door", { timeout: 120000 }, async () => {
  const { mf, call } = await boot({ ROOM_EXPORT_TOKEN: EXPORT_TOKEN, ROOM_RESTORE_TOKEN: RESTORE_TOKEN });
  try {
    const exportDoor = await call("/api/operator/export", { token: RESTORE_TOKEN });
    assert.equal(exportDoor.status, 401);
    const restoreDoor = await call("/api/operator/restore", { method: "POST", token: EXPORT_TOKEN, body: "{}\n" });
    assert.equal(restoreDoor.status, 401);
    const fromBackupDoor = await call("/api/operator/restore-from-backup", { method: "POST", token: EXPORT_TOKEN, body: "{}" });
    assert.equal(fromBackupDoor.status, 401);
    const own = await call("/api/operator/export", { token: EXPORT_TOKEN });
    assert.equal(own.status, 200);
  } finally {
    await mf.dispose();
  }
});

test("the same value in both secrets voids the split: both doors fail closed", { timeout: 120000 }, async () => {
  const { mf, call } = await boot({ ROOM_EXPORT_TOKEN: SHARED_TOKEN, ROOM_RESTORE_TOKEN: SHARED_TOKEN });
  try {
    const exportDoor = await call("/api/operator/export", { token: SHARED_TOKEN });
    assert.equal(exportDoor.status, 404);
    assert.equal(await exportDoor.text(), "Not found\n");
    const restoreDoor = await call("/api/operator/restore", { method: "POST", token: SHARED_TOKEN, body: "{}\n" });
    assert.equal(restoreDoor.status, 404);
    const fromBackupDoor = await call("/api/operator/restore-from-backup", { method: "POST", token: SHARED_TOKEN, body: "{}" });
    assert.equal(fromBackupDoor.status, 404);
  } finally {
    await mf.dispose();
  }
});

test("the retired ROOM_BACKUP_TOKEN opens nothing", { timeout: 120000 }, async () => {
  const { mf, call } = await boot({ ROOM_BACKUP_TOKEN: LEGACY_TOKEN });
  try {
    const exportDoor = await call("/api/operator/export", { token: LEGACY_TOKEN });
    assert.equal(exportDoor.status, 404);
    const restoreDoor = await call("/api/operator/restore", { method: "POST", token: LEGACY_TOKEN, body: "{}\n" });
    assert.equal(restoreDoor.status, 404);
    const fromBackupDoor = await call("/api/operator/restore-from-backup", { method: "POST", token: LEGACY_TOKEN, body: "{}" });
    assert.equal(fromBackupDoor.status, 404);
  } finally {
    await mf.dispose();
  }
});
