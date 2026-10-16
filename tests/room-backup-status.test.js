// readLatestBackupStatus: the operator status surface's backup measurement — the
// two most recent complete daily backups, growth measured between them,
// margin in days to the single-body cap. Incomplete or stale-version
// objects are not measurements and must be skipped, never estimated.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readLatestBackupStatus, SINGLE_BODY_CAP_BYTES } from "../cloudflare/room-backup.mjs";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const SHA = "ab".repeat(32);

function kvWith(entries) {
  const map = new Map(entries);
  return { get: async key => map.get(key) ?? null, put: async (key, value) => { map.set(key, value); } };
}
const manifest = (key, createdAt, bytes, version = 2) => JSON.stringify({
  kind: "room-backup-manifest", version, key, createdAt, bytes, sha256: SHA, parts: []
});
function r2With(heads) {
  const map = new Map(heads);
  return { head: async key => map.get(key) ?? null, put: async () => {} };
}
const r2Head = (bytes, uploaded) => ({
  customMetadata: { sha256: SHA, bytes: String(bytes), backupVersion: "2" },
  size: bytes, uploaded
});

describe("readLatestBackupStatus", () => {
  test("unconfigured bindings measure nothing", async () => {
    assert.equal(await readLatestBackupStatus({}, { now: NOW }), null);
    assert.equal(await readLatestBackupStatus({ ROOM_BACKUPS_KV: kvWith([]) }, { now: NOW }), null);
  });

  test("KV: growth and margin are measured between the two latest manifests", async () => {
    const kv = kvWith([
      ["room-backups/2026-10-14.ndjson", manifest("room-backups/2026-10-14.ndjson", "2026-10-14T03:00:00.000Z", 92_000_000)],
      ["room-backups/2026-10-13.ndjson", manifest("room-backups/2026-10-13.ndjson", "2026-10-13T03:00:00.000Z", 88_000_000)]
    ]);
    const status = await readLatestBackupStatus({ ROOM_BACKUPS_KV: kv }, { now: NOW });
    assert.equal(status.target, "kv");
    assert.equal(status.key, "room-backups/2026-10-14.ndjson");
    assert.equal(status.bytes, 92_000_000);
    assert.equal(status.at, "2026-10-14T03:00:00.000Z");
    assert.equal(status.previousBytes, 88_000_000);
    assert.equal(status.growthBytesPerDay, 4_000_000);
    assert.equal(status.singleBodyCapBytes, SINGLE_BODY_CAP_BYTES);
    assert.equal(status.marginDays, 2);
  });

  test("KV: a single backup yields no growth and no margin — not an estimate", async () => {
    const kv = kvWith([
      ["room-backups/2026-10-15.ndjson", manifest("room-backups/2026-10-15.ndjson", "2026-10-15T03:00:00.000Z", 90_000_000)]
    ]);
    const status = await readLatestBackupStatus({ ROOM_BACKUPS_KV: kv }, { now: NOW });
    assert.equal(status.bytes, 90_000_000);
    assert.equal(status.previousBytes, null);
    assert.equal(status.growthBytesPerDay, null);
    assert.equal(status.marginDays, null);
  });

  test("KV: a stale-version manifest is skipped, not measured", async () => {
    const kv = kvWith([
      ["room-backups/2026-10-14.ndjson", manifest("room-backups/2026-10-14.ndjson", "2026-10-14T03:00:00.000Z", 92_000_000, 1)],
      ["room-backups/2026-10-12.ndjson", manifest("room-backups/2026-10-12.ndjson", "2026-10-12T03:00:00.000Z", 84_000_000)]
    ]);
    const status = await readLatestBackupStatus({ ROOM_BACKUPS_KV: kv }, { now: NOW });
    assert.equal(status.key, "room-backups/2026-10-12.ndjson");
    assert.equal(status.growthBytesPerDay, null);
    assert.equal(status.marginDays, null);
  });

  test("R2: verified heads measure; an unverified head is skipped", async () => {
    const bucket = r2With([
      ["room-backups/2026-10-15.ndjson", { customMetadata: { sha256: "zz", bytes: "1", backupVersion: "2" }, size: 1, uploaded: new Date("2026-10-15T03:00:00.000Z") }],
      ["room-backups/2026-10-14.ndjson", r2Head(92_000_000, new Date("2026-10-14T03:00:00.000Z"))],
      ["room-backups/2026-10-13.ndjson", r2Head(88_000_000, new Date("2026-10-13T03:00:00.000Z"))]
    ]);
    const status = await readLatestBackupStatus({ ROOM_BACKUPS: bucket }, { now: NOW });
    assert.equal(status.target, "r2");
    assert.equal(status.bytes, 92_000_000);
    assert.equal(status.at, "2026-10-14T03:00:00.000Z");
    assert.equal(status.growthBytesPerDay, 4_000_000);
    assert.equal(status.marginDays, 2);
  });

  test("shrinking backups never produce a negative-margin claim", async () => {
    const kv = kvWith([
      ["room-backups/2026-10-14.ndjson", manifest("room-backups/2026-10-14.ndjson", "2026-10-14T03:00:00.000Z", 80_000_000)],
      ["room-backups/2026-10-13.ndjson", manifest("room-backups/2026-10-13.ndjson", "2026-10-13T03:00:00.000Z", 88_000_000)]
    ]);
    const status = await readLatestBackupStatus({ ROOM_BACKUPS_KV: kv }, { now: NOW });
    assert.equal(status.growthBytesPerDay, -8_000_000);
    assert.equal(status.marginDays, null);
  });
});
