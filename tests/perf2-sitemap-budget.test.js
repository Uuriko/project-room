// PERF2-SITEMAP (C-2) budget tests — the PERF-2 programme's sitemap rows,
// in the PERF2-MEASURE harness pattern (PR #4153: shadow db.prepare counts
// statements; fixture sizes asserted against independent SQL counts before
// any reading is trusted).
//
// Budgets bound here (perf2-program-2026-10-18 §1):
//   - the room walk (listPublicRoomSitemap) costs <20 statements at 10k
//     rooms and is flat in room count (the pre-fix N+1 cost 10,001);
//   - the receipt walk covers EVERY public receipt (0 missing) at 10k and
//     50k receipts — the pre-fix default call silently clamped at 1,000 —
//     with each receipt in exactly one page and per-page statement counts
//     flat in corpus size.
//
// Statement counts transfer to workerd; Node wall-clock never decides here.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  listPublicRoomSitemap,
  listPublicReceiptSitemap,
  countPublicReceiptSitemap,
  RECEIPT_SITEMAP_PAGE_SIZE,
} from "../server/public-read-model.mjs";
import { listPublicReceiptSitemap as listSitemapViaWrapper } from "../server/receipts-live.mjs";

// Shadow db.prepare, copied from scripts/perf-budgets.mjs (PR #4153): the
// raw prepare is kept for independent completeness counts.
function makeCounter(db) {
  const counts = { statements: 0, execs: 0, rowsOut: 0 };
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    counts.statements += 1;
    const stmt = realPrepare(sql);
    for (const method of ["all", "get", "run"]) {
      const original = stmt[method]?.bind(stmt);
      if (!original) continue;
      stmt[method] = (...args) => {
        counts.execs += 1;
        const out = original(...args);
        if (method === "all" && Array.isArray(out)) counts.rowsOut += out.length;
        return out;
      };
    }
    return stmt;
  };
  return {
    counts,
    raw: realPrepare,
    reset() { counts.statements = 0; counts.execs = 0; counts.rowsOut = 0; },
    measure(fn) {
      this.reset();
      const out = fn();
      return { out, ...counts };
    },
  };
}

function makeStore() {
  const db = new DatabaseSync(":memory:");
  const store = new RoomStore(":memory:", { database: db });
  store.initialize(initialRoom("commons"));
  return { db, store };
}

// S5 shape (bench3): public_rooms rows for the sitemap walk.
function seedRooms({ raw, db }, from, to) {
  const insRoom = raw(`INSERT INTO public_rooms (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?, 'T', 'p', 1, 1, '[]', '[]', '[]', 1, 'request', NULL, NULL, '2026-01-01', '2026-01-01')`);
  db.exec("BEGIN");
  for (let i = from; i < to; i++) insRoom.run(`room-${i}`);
  db.exec("COMMIT");
}

// S1 shape (bench1): receipt corpus — work-claim / public-work / work-item
// mix, 25% concentrated in one fat room.
function seedReceipts({ raw, db }, from, to) {
  const insReceipt = raw(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, ?, ?, ?, ?, 'T', '["agent-a"]', '["human-b"]', ?, ?, '{}', ?, 'https://room.trydemigod.com/?start=room')`);
  const insPwr = raw(`INSERT INTO public_work_receipts (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?, ?, 'ns', 1, 'agent-a', 'x', 'abc', 1, ?, 1700000000)`);
  db.exec("BEGIN");
  for (let i = from; i < to; i++) {
    const at = new Date(1700000000000 + i * 1000).toISOString();
    const room = i % 4 === 0 ? "fatroom" : `room-${i % 200}`;
    const kind = i % 5;
    if (kind <= 1) {
      const merged = i % 3 === 0;
      insReceipt.run(`wcr_${i}`, `Work ${i}`, "work-claim", room, room, merged ? "https://github.com/x/y/pull/1" : null, merged ? at : null, at);
    } else if (kind <= 3) {
      insReceipt.run(`pwr_${i}`, `Work ${i}`, "public-work", "public-work", room, null, null, at);
      insPwr.run(`pwr_${i}`, `off_${i}`, JSON.stringify({ receiptId: `pwr_${i}`, state: "submitted", verification: "hash_only", createdAt: at }));
    } else {
      insReceipt.run(`wir_${i}`, `Work ${i}`, "work-item", room, room, null, null, at);
    }
  }
  db.exec("COMMIT");
}

test("room walk: statement count is flat in room count and under budget", () => {
  const ctx = makeStore();
  const counter = makeCounter(ctx.db);
  let seeded = 0;
  const readings = new Map();
  for (const size of [1000, 10000]) {
    seedRooms({ raw: counter.raw, db: ctx.db }, seeded, size);
    seeded = size;
    const total = counter.raw("SELECT COUNT(*) AS n FROM public_rooms").get().n;
    assert.equal(total, size, `fixture size asserted at ${size}`);
    const walk = counter.measure(() => listPublicRoomSitemap(ctx.store));
    assert.equal(walk.out.length, size, `walk returns every seeded room at ${size}`);
    readings.set(size, walk.statements);
  }
  assert.ok(readings.get(10000) < 20, `room walk at 10k rooms costs ${readings.get(10000)} statements (budget <20)`);
  assert.equal(readings.get(10000), readings.get(1000),
    `room walk statements flat: 1k=${readings.get(1000)} 10k=${readings.get(10000)}`);
  ctx.store.close();
});

test("room walk: an operator-unpublished room is excluded by the walk itself", () => {
  const ctx = makeStore();
  const counter = makeCounter(ctx.db);
  seedRooms({ raw: counter.raw, db: ctx.db }, 0, 10);
  counter.raw("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'room-3', '2026-01-02T00:00:00.000Z', 'op')").run();
  const walk = counter.measure(() => listPublicRoomSitemap(ctx.store));
  assert.equal(walk.out.length, 9);
  assert.ok(!walk.out.some(row => row.slug === "room-3"), "unpublished room absent");
  assert.ok(walk.statements < 20, `statements ${walk.statements}`);
  ctx.store.close();
});

test("receipt walk: default read covers the whole corpus — no silent clamp", () => {
  const ctx = makeStore();
  const counter = makeCounter(ctx.db);
  seedReceipts({ raw: counter.raw, db: ctx.db }, 0, 10000);
  const total = counter.raw("SELECT COUNT(*) AS n FROM public_receipts").get().n;
  assert.equal(total, 10000, "fixture size asserted at 10000");
  const all = listPublicReceiptSitemap(ctx.store);
  assert.equal(all.length, 10000, `default call returns every receipt (got ${all.length}; the pre-fix clamp returned 1000)`);
  ctx.store.close();
});

test("receipt walk: paged enumeration is complete, exactly-once, and flat per page", () => {
  const ctx = makeStore();
  const counter = makeCounter(ctx.db);
  let seeded = 0;
  for (const size of [10000, 50000]) {
    seedReceipts({ raw: counter.raw, db: ctx.db }, seeded, size);
    seeded = size;
    const total = counter.raw("SELECT COUNT(*) AS n FROM public_receipts").get().n;
    assert.equal(total, size, `fixture size asserted at ${size}`);
    const counted = counter.measure(() => countPublicReceiptSitemap(ctx.store));
    assert.equal(counted.out, size, "count statement reports the true total");
    assert.ok(counted.statements <= 2, `count costs ${counted.statements} statements`);
    const seen = new Set();
    const pageStatements = [];
    const pages = Math.ceil(size / RECEIPT_SITEMAP_PAGE_SIZE);
    for (let page = 0; page < pages; page++) {
      const read = counter.measure(() => listSitemapViaWrapper(ctx.store, {
        limit: RECEIPT_SITEMAP_PAGE_SIZE,
        offset: page * RECEIPT_SITEMAP_PAGE_SIZE,
      }));
      pageStatements.push(read.statements);
      for (const entry of read.out) {
        const id = String(entry.path).split("/").pop();
        assert.ok(!seen.has(id), `receipt ${id} appears in exactly one page`);
        seen.add(id);
      }
    }
    assert.equal(seen.size, size, `paged walk covers every receipt at ${size} (missing ${size - seen.size})`);
    const spread = Math.max(...pageStatements) - Math.min(...pageStatements);
    assert.ok(Math.max(...pageStatements) <= 8, `per-page statements flat (max ${Math.max(...pageStatements)} at ${size})`);
    assert.ok(spread <= 2, `per-page statement spread ${spread} at ${size}`);
  }
  ctx.store.close();
});

test("receipt walk: the owner toggle hides a private room's receipts from every page", () => {
  const ctx = makeStore();
  const counter = makeCounter(ctx.db);
  seedReceipts({ raw: counter.raw, db: ctx.db }, 0, 2000);
  // fatroom holds 25% of the corpus; its owner turns public receipts off.
  counter.raw("INSERT INTO room_directory_settings (room_id, public_receipts, updated_at) VALUES ('fatroom', 0, 1700000000)").run();
  const seen = new Set();
  const pages = Math.ceil(2000 / RECEIPT_SITEMAP_PAGE_SIZE);
  for (let page = 0; page < pages; page++) {
    for (const entry of listSitemapViaWrapper(ctx.store, {
      limit: RECEIPT_SITEMAP_PAGE_SIZE,
      offset: page * RECEIPT_SITEMAP_PAGE_SIZE,
    })) seen.add(String(entry.path).split("/").pop());
  }
  // wcr_/wir_ rows name fatroom as their room; pwr_ rows resolve through
  // their task room (seeded offers point at room-N rooms, not fatroom).
  const fatCount = counter.raw("SELECT COUNT(*) AS n FROM public_receipts WHERE room_id='fatroom' AND source IN ('work-claim','work-item')").get().n;
  assert.ok(fatCount > 0, "fixture has fat-room receipts");
  assert.equal(seen.size, 2000 - fatCount, "private room's receipts absent from the paged sitemap set");
  ctx.store.close();
});
