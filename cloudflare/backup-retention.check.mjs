// Tiered backup retention (audit-50x C-04): 7 daily + 4 weekly + 3 monthly
// TTL classes replace the flat 35-day TTL on KV backups. The class is a
// function of the backup's own UTC date — the 1st of a month is monthly, a
// Sunday is weekly, any other day is daily — and the per-key TTL the KV
// writer already supported is the whole mechanism. These checks pin:
//   (a) class assignment by date, including the class boundaries;
//   (b) a full verified restore from the oldest retained class (monthly)
//       through the real Durable Object restore-from-backup route — the
//       correctness invariant (manifest last, part hashes, trailer digests)
//       must hold for a copy of any retained class;
//   (c) expiry: simulating the recorded per-backup TTLs over two years of
//       nightly writes, no copy survives past its class span, and the
//       retained set always covers the classes' restore points.
// Backup content, format, chunking and restore verification are untouched
// by retention; nothing here re-tests them beyond (b)'s full verification.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";
import { exportNdjsonStream } from "../server/room-export.mjs";
import {
  backupObjectKey,
  backupRetention,
  backupRetentionClass,
  backupTtlSeconds,
  writeKvBackup,
} from "./room-backup.mjs";

const DAY_SECONDS = 24 * 60 * 60;
const utc = (year, month, day, hour = 6, minute = 30) => new Date(Date.UTC(year, month - 1, day, hour, minute));
const isoDay = date => date.toISOString().slice(0, 10);

// (a) Class assignment by date, at and around every boundary.
test("retention class assignment by backup date, including boundaries", () => {
  const cases = [
    // Daily: an ordinary weekday, and the days either side of a Sunday.
    ["2026-10-08", "daily", 7 * DAY_SECONDS], // Thursday
    ["2026-10-10", "daily", 7 * DAY_SECONDS], // Saturday, day before a weekly
    ["2026-10-12", "daily", 7 * DAY_SECONDS], // Monday, day after a weekly
    // Weekly: Sundays, kept 4 weeks.
    ["2026-10-11", "weekly", 28 * DAY_SECONDS], // Sunday
    ["2026-10-04", "weekly", 28 * DAY_SECONDS], // Sunday
    // Monthly: the 1st, whatever weekday it falls on, kept until the 1st
    // three calendar months later (89–92 days depending on the months).
    ["2026-10-01", "monthly", 92 * DAY_SECONDS], // Thursday; Oct 1 -> Jan 1
    ["2026-09-01", "monthly", 91 * DAY_SECONDS], // Tuesday; Sep 1 -> Dec 1
    ["2027-02-01", "monthly", 89 * DAY_SECONDS], // Monday; Feb 1 -> May 1 (shortest span)
    ["2028-02-01", "monthly", 90 * DAY_SECONDS], // leap February; Feb 1 -> May 1
    // Monthly wins when the 1st is also a Sunday.
    ["2026-11-01", "monthly", 92 * DAY_SECONDS], // Sunday and the 1st; Nov 1 -> Feb 1
  ];
  for (const [day, retentionClass, ttlSeconds] of cases) {
    const date = new Date(`${day}T06:30:00Z`);
    assert.equal(backupRetentionClass(date), retentionClass, day);
    assert.equal(backupTtlSeconds(date), ttlSeconds, day);
    assert.deepEqual(backupRetention(date), { retentionClass, ttlSeconds }, day);
    assert.equal(backupObjectKey(date), `room-backups/${day}.ndjson`, day);
  }
});

// A recording KV double in the shape of tests/room-backup-export.test.js:
// it keeps every put's options so the TTL a backup actually got is visible.
function recordingKv() {
  const map = new Map();
  const puts = [];
  return {
    map,
    puts,
    async get(key) { return map.has(key) ? map.get(key).value : null; },
    async put(key, value, options = {}) {
      const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      puts.push({ key, options });
      map.set(key, { value: bytes, options });
    },
  };
}

const sha256 = value => createHash("sha256").update(value).digest("hex");

// (a) applied: the writer stamps every key of a backup — parts and the
// manifest written last — with that backup's class TTL, and the manifest
// still pins every part's hash (the invariant retention must not disturb).
test("writeKvBackup stamps parts and manifest with the class TTL, manifest last", async () => {
  const body = "retention fixture export\n".repeat(50);
  for (const [day, ttlSeconds] of [["2026-10-08", 7 * DAY_SECONDS], ["2026-10-11", 28 * DAY_SECONDS], ["2026-09-01", 91 * DAY_SECONDS]]) {
    const kv = recordingKv();
    const key = `room-backups/${day}.ndjson`;
    const manifest = await writeKvBackup(kv, key, body, { partBytes: 64, now: new Date(`${day}T06:30:00Z`).getTime() });
    assert.ok(manifest.parts.length > 1, `${day}: the fixture spans several parts`);
    assert.equal(kv.puts.at(-1).key, key, `${day}: the manifest is written last`);
    for (const put of kv.puts) assert.equal(put.options.expirationTtl, ttlSeconds, `${day}: ${put.key}`);
    for (const part of manifest.parts) {
      const stored = kv.map.get(part.key);
      assert.ok(stored, `${day}: ${part.key} stored`);
      assert.equal(part.sha256, sha256(stored.value), `${day}: ${part.key} hash pinned by the manifest`);
      assert.equal(part.bytes, stored.value.byteLength, `${day}: ${part.key} size pinned by the manifest`);
    }
    assert.equal(manifest.sha256, sha256(body), `${day}: whole-backup hash pinned by the manifest`);
  }
  // An explicit ttlSeconds remains a caller override for that one backup.
  const kv = recordingKv();
  await writeKvBackup(kv, "room-backups/2026-10-08.ndjson", body, { ttlSeconds: 12345 });
  for (const put of kv.puts) assert.equal(put.options.expirationTtl, 12345);
});

// (c) Expiry logic over two years of nightly writes, driven through the
// real writer so the TTLs simulated are the TTLs production keys carry.
test("no copy survives past its class span, and the retained set always covers every class", async () => {
  const entries = [];
  const start = Date.UTC(2025, 5, 1); // 2025-06-01, so monthly coverage is in steady state by the first probe
  const end = Date.UTC(2027, 5, 1); // 2027-06-01
  for (let at = start; at < end; at += DAY_SECONDS * 1000) {
    const writtenAt = at + (6 * 60 + 30) * 60 * 1000;
    const kv = recordingKv();
    const key = backupObjectKey(new Date(writtenAt));
    await writeKvBackup(kv, key, `nightly ${key}\n`, { now: writtenAt });
    const manifestPut = kv.puts.at(-1);
    assert.equal(manifestPut.key, key);
    for (const put of kv.puts) assert.equal(put.options.expirationTtl, manifestPut.options.expirationTtl, key);
    entries.push({ day: isoDay(new Date(writtenAt)), writtenAt, ttlSeconds: manifestPut.options.expirationTtl, retentionClass: backupRetentionClass(new Date(writtenAt)) });
  }
  const aliveAt = probe => entries.filter(entry => entry.writtenAt <= probe && probe < entry.writtenAt + entry.ttlSeconds * 1000);

  // Spot check, hand-derived: just after the 2026-10-16 backup, the
  // retained set is the daily copies of Oct 10/12/13/14/15/16, the weekly
  // copies of Sep 20, Sep 27, Oct 4, Oct 11, and the monthly copies of
  // Aug 1, Sep 1, Oct 1 — 13 distinct copies in the 7 + 4 + 3 slots.
  const spot = aliveAt(utc(2026, 10, 16, 7).getTime());
  const byClass = { daily: 0, weekly: 0, monthly: 0 };
  for (const entry of spot) byClass[entry.retentionClass] += 1;
  assert.deepEqual(byClass, { daily: 6, weekly: 4, monthly: 3 });
  assert.equal(spot.length, 13);

  // A copy is gone the moment its class span ends — daily at 7 days,
  // weekly at 4 weeks, monthly on the 1st three calendar months later.
  const entryFor = day => entries.find(entry => entry.day === day);
  for (const [day, spanSeconds] of [["2026-10-08", 7 * DAY_SECONDS], ["2026-10-11", 28 * DAY_SECONDS], ["2026-10-01", 92 * DAY_SECONDS]]) {
    const entry = entryFor(day);
    assert.ok(entry, day);
    assert.equal(entry.ttlSeconds, spanSeconds, day);
    const justInside = entry.writtenAt + spanSeconds * 1000 - 60 * 1000;
    const justOutside = entry.writtenAt + spanSeconds * 1000 + 60 * 1000;
    assert.ok(aliveAt(justInside).includes(entry), `${day} retained inside its span`);
    assert.ok(!aliveAt(justOutside).includes(entry), `${day} expired past its span`);
  }

  // Every day for a year: caps hold, and coverage holds — every date in
  // the last 7 days, the last 4 Sundays, and the last 3 month-firsts has
  // a retained copy, and nothing else is retained.
  for (let probeDay = Date.UTC(2026, 0, 1); probeDay < Date.UTC(2027, 0, 1); probeDay += DAY_SECONDS * 1000) {
    const probe = probeDay + 7 * 60 * 60 * 1000; // just after that day's write
    const alive = aliveAt(probe);
    const label = isoDay(new Date(probe));
    assert.ok(alive.length <= 14, `${label}: ${alive.length} retained copies exceeds 7 + 4 + 3`);
    const counts = { daily: 0, weekly: 0, monthly: 0 };
    for (const entry of alive) counts[entry.retentionClass] += 1;
    assert.ok(counts.daily <= 7 && counts.weekly <= 4 && counts.monthly <= 3, `${label}: class counts ${JSON.stringify(counts)}`);
    const aliveDays = new Set(alive.map(entry => entry.day));
    for (let back = 0; back < 7; back += 1)
      assert.ok(aliveDays.has(isoDay(new Date(probeDay - back * DAY_SECONDS * 1000))), `${label}: daily coverage missing ${back} day(s) back`);
    const lastSundays = [];
    for (let back = 0; lastSundays.length < 4; back += 1) {
      const day = new Date(probeDay - back * DAY_SECONDS * 1000);
      if (day.getUTCDay() === 0) lastSundays.push(isoDay(day));
    }
    for (const day of lastSundays) assert.ok(aliveDays.has(day), `${label}: weekly coverage missing Sunday ${day}`);
    const lastFirsts = [];
    for (let back = 0; lastFirsts.length < 3; back += 1) {
      const day = new Date(probeDay - back * DAY_SECONDS * 1000);
      if (day.getUTCDate() === 1) lastFirsts.push(isoDay(day));
    }
    for (const day of lastFirsts) assert.ok(aliveDays.has(day), `${label}: monthly coverage missing the 1st ${day}`);
  }
});

// (b) A backup in the oldest retained class (monthly) restores through the
// real Durable Object route with full verification, and survives a restart.
// Mirrors restore-fk-order.check.mjs's Miniflare shape.
// Repo root, derived from this file (cloudflare/ sits directly under it) so
// the check runs the same from the repo root and from cloudflare/, which is
// where the cloudflare test script invokes it.
const source = process.env.ROOM_SOURCE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(source, "cloudflare/package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");

const fixture = `
import entry, { ProjectRoom } from "./room.mjs";
export class RetentionProbeRoom extends ProjectRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__fixture/state") {
      const db = this.store.db;
      return Response.json({
        rooms: db.prepare("SELECT count(*) AS n FROM rooms").get().n,
        events: db.prepare("SELECT count(*) AS n FROM events").get().n,
      });
    }
    return super.fetch(request);
  }
}
export default entry;
`;

test("a monthly-class backup restores with full verification and survives a restart", { timeout: 120000 }, async t => {
  const key = "room-backups/2026-09-01.ndjson"; // 2026-09-01: monthly class, the oldest retained tier
  assert.deepEqual(backupRetention(new Date("2026-09-01T06:30:00Z")), { retentionClass: "monthly", ttlSeconds: 91 * DAY_SECONDS });
  const bundled = await build({ stdin: { contents: fixture, resolveDir: join(source, "cloudflare"), sourcefile: "backup-retention-fixture.mjs" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });
  const directory = await mkdtemp(join(tmpdir(), "backup-retention-"));
  let mf, seed;
  try {
    const origin = "https://room.example.test", token = randomUUID();
    const config = {
      modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { ROOM: { className: "RetentionProbeRoom", useSQLite: true } },
      durableObjectsPersist: join(directory, "persist"),
      kvNamespaces: ["ROOM_BACKUPS_KV"], kvPersist: join(directory, "kv"),
      bindings: { ROOM_ORIGIN: origin, ROOM_BACKUP_TOKEN: token },
    };
    mf = new Miniflare(config);
    seed = new RoomStore(join(directory, "seed.sqlite"));
    const events = [...initialRoom(), ...Array.from({ length: 10 }, (_, i) =>
      event({ roomId: "commons", actorId: "owner", type: T.MESSAGE_POSTED, data: { messageId: `retention-${i}`, body: `Synthetic monthly restore ${i}` } }))];
    seed.initialize(events);
    const kv = await mf.getKVNamespace("ROOM_BACKUPS_KV");
    await writeKvBackup(kv, key, exportNdjsonStream(seed.db), { partBytes: 16384, now: Date.UTC(2026, 8, 1, 6, 30) });
    const state = async () => { const r = await mf.dispatchFetch(`${origin}/__fixture/state`); assert.equal(r.status, 200); return r.json(); };
    assert.deepEqual(await state(), { rooms: 0, events: 0 });
    const restored = await mf.dispatchFetch(`${origin}/api/operator/restore-from-backup`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ key }),
    });
    const result = await restored.json();
    assert.equal(restored.status, 200, JSON.stringify(result));
    assert.equal(result.verified, true);
    assert.equal(result.contentVerification, "full");
    assert.equal(result.events, events.length);
    assert.deepEqual(await state(), { rooms: 1, events: events.length });
    await mf.dispose();
    mf = new Miniflare(config);
    assert.deepEqual(await state(), { rooms: 1, events: events.length });
  } finally {
    seed?.close();
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
