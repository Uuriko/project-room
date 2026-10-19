// CAP-PROBE-BINDING (ATLAS-STORAGE P1 + VALUE-LIMIT-TRUTH): the projection
// cap is derived from the runtime probe (server/storage-limits.mjs), not
// restated as constants beside it. The platform value limit has moved twice
// without notice (2,200,000 -> 4 MiB -> 8 MiB + 34 B); the store already
// measures it (sqliteValueLimit) but used to enforce against a fixed 4 MiB
// and escalate store growth against a fixed 3.5 MB, so on a runtime whose
// limit drops the first wall a room meets is the platform's own refusal.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  PROJECTION_CAP_CEILING_BYTES,
  projectionCapForValueLimit,
  probedValueLimitBytes,
  effectiveProjectionCapBytes,
  storeProjectionCapBytes
} from "../server/storage-limits.mjs";
import { STORE_GROWTH_LIMITS, storeGrowthLimits, storeGrowthBreach } from "../server/jobs.mjs";

const CEILING = 4 * 1024 * 1024;
const tooBig = () => Object.assign(new Error("string or blob too big: SQLITE_TOOBIG"), { code: "ERR_SQLITE_ERROR" });

// A db whose only refusal is the probe's: values past `limit` are too big.
function fakeDb(limit, refuse = tooBig) {
  return {
    prepare(sql) {
      assert.match(sql, /zeroblob/);
      return { get(bytes) { if (bytes > limit) throw refuse(); return { n: bytes }; } };
    }
  };
}

// A real node:sqlite handle wearing a smaller runtime's limit: the probe's
// zeroblob question is answered as workerd at `limit` would, everything else
// is the real database. This is the local-Miniflare (2,200,000) shape; the
// Durable Object adapter's pilot_limit-shaped refusal is pinned in
// tests/storage-limits.test.js.
function runtimeLimitedDb(real, limit) {
  const realPrepare = real.prepare.bind(real);
  const probeStatement = { get(bytes) { if (bytes > limit) throw tooBig(); return { n: bytes }; } };
  // The store patches db.prepare in place (its projection watch), so the
  // double must honour later assignments instead of shadowing them, and
  // must delegate to the prepare captured before any patch — looking it
  // up per call would recurse through the patch.
  const assigned = new Map();
  return new Proxy(real, {
    get(target, property) {
      if (assigned.has(property)) return assigned.get(property);
      if (property === "prepare") return sql => (String(sql).includes("zeroblob") ? probeStatement : realPrepare(sql));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) { assigned.set(property, value); return true; }
  });
}

// An advancing clock, as in tests/projection-at-rest.test.js: sustained
// posting trips the room flood guard unless time moves between commands.
const advancingClock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };

function openStore(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cap-probe-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file, { bodiesAtRest: false, now: advancingClock(), ...options });
  store.initialize(initialRoom());
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, file, directory };
}

const bigBody = (tag, n = 45000) => `${tag}:` + "x".repeat(n);

function postUntilRefused(store, { maxPosts = 80 } = {}) {
  const key = store.issueAccessKey("commons", "owner");
  let posts = 0;
  let refusal = null;
  for (let i = 0; i < maxPosts; i += 1) {
    try {
      store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m${i}`, body: bigBody(`m${i}`) } });
      posts += 1;
    } catch (error) { refusal = error; break; }
  }
  const stored = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  return { posts, refusal, storedBytes: Buffer.byteLength(stored) };
}

test("the ceiling is today's application guard, and PILOT_LIMITS still carries it", () => {
  assert.equal(PROJECTION_CAP_CEILING_BYTES, CEILING);
  assert.equal(PILOT_LIMITS.projectionBytes, CEILING);
});

test("the effective cap follows the measured limit: min(ceiling, probed x 0.9)", () => {
  assert.equal(projectionCapForValueLimit(2_200_000), 1_980_000); // repo-pinned local workerd
  assert.equal(projectionCapForValueLimit(4_194_304), 3_774_873); // 4 MiB workerd: margin binds
  assert.equal(projectionCapForValueLimit(8_388_642), CEILING); // production today: ceiling binds
  assert.equal(projectionCapForValueLimit(1_000_000_000), CEILING); // node:sqlite
});

test("an unmeasurable limit falls back to today's constant, never a guessed number", () => {
  for (const unknown of [null, undefined, Number.NaN, 0, -1]) assert.equal(projectionCapForValueLimit(unknown), CEILING);
  assert.equal(effectiveProjectionCapBytes(null), CEILING);
  assert.equal(effectiveProjectionCapBytes({}), CEILING);
  const unauthorized = { prepare: () => ({ get: bytes => { if (bytes > 5000) throw new Error("not authorized to use function: zeroblob"); return { n: bytes }; } }) };
  assert.equal(probedValueLimitBytes(unauthorized), null);
  assert.equal(effectiveProjectionCapBytes(unauthorized), CEILING);
});

test("the probe-bound derivation reads the handle's measured limit", () => {
  assert.equal(probedValueLimitBytes(fakeDb(2_200_000)), 2_200_000);
  assert.equal(effectiveProjectionCapBytes(fakeDb(2_200_000)), 1_980_000);
  assert.equal(effectiveProjectionCapBytes(fakeDb(8_388_642)), CEILING);
});

test("a store-like object resolves its cap: derived field, then its db, then the ceiling", () => {
  assert.equal(storeProjectionCapBytes({ projectionCapBytes: 123_456 }), 123_456);
  assert.equal(storeProjectionCapBytes({ db: fakeDb(2_200_000) }), 1_980_000);
  assert.equal(storeProjectionCapBytes({}), CEILING);
  assert.equal(storeProjectionCapBytes(null), CEILING);
});

test("RoomStore on stock Node derives today's cap (probe reads 1e9)", t => {
  const { store } = openStore(t);
  assert.equal(store.valueLimitBytes, 1_000_000_000);
  assert.equal(store.projectionCapBytes, CEILING);
});

test("RoomStore on a 2.2M runtime derives the capped value", t => {
  const directory = mkdtempSync(join(tmpdir(), "cap-probe-"));
  const file = join(directory, "room.sqlite");
  const real = new DatabaseSync(file);
  const store = new RoomStore(file, { bodiesAtRest: false, now: advancingClock(), database: runtimeLimitedDb(real, 2_200_000) });
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.valueLimitBytes, 2_200_000);
  assert.equal(store.projectionCapBytes, 1_980_000);
});

test("a projection write refuses at the DERIVED cap on a 2.2M runtime, not the 4 MiB constant", t => {
  const directory = mkdtempSync(join(tmpdir(), "cap-probe-"));
  const file = join(directory, "room.sqlite");
  const real = new DatabaseSync(file);
  const store = new RoomStore(file, { bodiesAtRest: false, now: advancingClock(), database: runtimeLimitedDb(real, 2_200_000) });
  store.initialize(initialRoom());
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  const { posts, refusal, storedBytes } = postUntilRefused(store);
  assert.ok(refusal, "growth is refused");
  assert.equal(refusal.code, "pilot_limit");
  assert.ok(posts >= 30, `the room grew substantially before refusing (${posts} posts)`);
  assert.ok(storedBytes <= 1_980_000, `stored projection ${storedBytes} is within the derived cap`);
  assert.ok(storedBytes > 1_980_000 - 90_000, `stored projection ${storedBytes} stopped at the derived wall, not earlier`);
});

test("the same room on an unlimited runtime writes past the 2.2M-derived cap", t => {
  const { store } = openStore(t);
  const { posts, refusal, storedBytes } = postUntilRefused(store, { maxPosts: 50 });
  assert.equal(refusal, null);
  assert.ok(posts > 40 && storedBytes > 1_980_000, `wrote ${posts} posts / ${storedBytes} bytes with no refusal`);
});

test("a writable open refuses when a stored projection already passes the probed limit, naming the room", t => {
  const directory = mkdtempSync(join(tmpdir(), "cap-probe-"));
  const file = join(directory, "room.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const grown = new RoomStore(file, { bodiesAtRest: false, now: advancingClock() });
  grown.initialize(initialRoom());
  const { refusal, storedBytes } = postUntilRefused(grown, { maxPosts: 75 });
  assert.equal(refusal, null);
  assert.ok(storedBytes > 2_200_000, `precondition: stored projection ${storedBytes} passes the 2.2M runtime limit`);
  grown.close();

  const realLimited = new DatabaseSync(file);
  assert.throws(
    () => new RoomStore(file, { bodiesAtRest: false, now: advancingClock(), database: runtimeLimitedDb(realLimited, 2_200_000) }),
    error => /commons/.test(error.message) && /measured storage value limit/.test(error.message)
  );
  // (No realLimited.close(): the refusing constructor already closed the
  // handle it was handed, as the schema-refusal paths do.)

  // The same database opens writable on a runtime whose limit fits it.
  const realFitting = new DatabaseSync(file);
  const fitting = new RoomStore(file, { bodiesAtRest: false, now: advancingClock(), database: runtimeLimitedDb(realFitting, 8_388_642) });
  assert.equal(fitting.projectionCapBytes, CEILING);
  fitting.close();
});

test("store-growth escalates against the store's derived cap, not a restated constant", () => {
  const derived = storeGrowthLimits({ projectionCapBytes: CEILING });
  assert.equal(derived.maxProjectionBytes, 3_495_253); // floor(4 MiB x 5/6): today's 3.5 MB line, tracking the wall
  assert.equal(derived.dbBytes, STORE_GROWTH_LIMITS.dbBytes);
  assert.equal(storeGrowthLimits({ projectionCapBytes: 1_980_000 }).maxProjectionBytes, 1_650_000);
  assert.equal(storeGrowthLimits({}), STORE_GROWTH_LIMITS);
  assert.equal(storeGrowthLimits(null), STORE_GROWTH_LIMITS);
  const gauges = { rooms: 1, events: 1, maxProjectionBytes: 3_495_254, dbBytes: 0 };
  assert.equal(storeGrowthBreach(gauges, derived), "maxProjectionBytes");
  assert.equal(storeGrowthBreach(gauges, STORE_GROWTH_LIMITS), null);
});
