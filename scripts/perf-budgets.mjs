#!/usr/bin/env node
// perf-budgets.mjs — PERF-2 deterministic budget suite (PERF2-MEASURE).
//
// Productizes the HUNT-SCALE-SPIKE benches (hunt-scratch/scale/bench1/1b/2/3)
// into one runnable instrument for the PERF-2 programme's §1 budgets
// (~/workspace/strategy-2026-10/perf2-program-2026-10-18.md). Shapes S1–S5
// are the scale lane's fixtures, seeded through the repo's own schema and
// writers on in-memory node:sqlite stores.
//
// METHOD (the scale lane's rule): statement counts (db.prepare calls),
// SQL exec counts, and rows materialised transfer to workerd; absolute
// Node milliseconds do NOT — they are printed for curve shape only and
// never decide a budget.
//
// COMPLETENESS (CN-1's lesson: an instrument that silently under-captures
// is worse than none). Before any reading is trusted, every fixture's size
// is asserted against an INDEPENDENT SQL count taken through an unshadowed
// prepare; the front-door counters are asserted equal to the counters
// derived from the materialised collect (the parity property PR #4122's
// own test pins); the board's claimableCount is asserted against SQL.
// A completeness failure exits 2 in every mode — the instrument is broken,
// not the product.
//
// ENFORCEMENT PROTOCOL (§5.2 of the programme): each budget row carries an
// `enforce` flag. Budgets whose fix has not landed yet are tracked, not
// enforced — front-door/receipt counters ride PR #4122 (open), the board
// rides C-1 (PERF2-BOARD), the sitemap rides C-2 (PERF2-SITEMAP). The PR
// that lands a fix flips its rows to enforce:true in the same diff; from
// then on a breach fails this suite like any red test. `--check` enforces
// ALL rows regardless of flags (lane acceptance runs use it today).
//
// Usage:
//   node scripts/perf-budgets.mjs [--small] [--json] [--check]
//     --small   CI shape (S1@1k, S3@200, S5@1k, S4@1k): completeness and
//               parity only; budgets are evaluated at full shapes.
//     --check   exit 3 when any budget row breaches (not just enforced).
//   Exit codes: 0 ok · 2 completeness/parity failure · 3 budget breach
//               (enforced rows, or any row under --check) · 1 failure.
// Tests: tests/perf-budgets.test.js runs the small shape in the suite.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts, queryRoomProof, queryPublicReceipts } from "../server/receipts-live.mjs";
import { syncDirectoryCard, listPublicRoomSitemap, listPublicReceiptSitemap } from "../server/public-read-model.mjs";
import { frontDoorFacts } from "../server/routes/front-door.mjs";
import { releaseExpired } from "../server/work-claims.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// ---------------------------------------------------------------------------
// Counting: shadow db.prepare. `statements` = prepare calls (the scale
// lane's unit — every §1 statement baseline was measured this way);
// `execs` = statement executions (all/get/run); `rowsOut` = rows returned
// by .all(). The raw prepare is kept for independent completeness counts.

export function makeCounter(db) {
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
      const t0 = performance.now();
      const out = fn();
      return { out, ms: performance.now() - t0, ...counts };
    },
  };
}

function makeStore() {
  const db = new DatabaseSync(":memory:");
  const store = new RoomStore(":memory:", { database: db });
  store.initialize(initialRoom("commons"));
  return { db, store };
}

// ---------------------------------------------------------------------------
// S1 — receipt corpus (bench1): 40% work-claim, 40% public-work with source
// records, 20% work-item; 25% concentrated in one fat room.

function seedReceipts({ db, raw }, from, to) {
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

// S2 — directory write path (bench1b): half the corpus names agent-a.
function seedDirectory({ db, raw }, from, to) {
  const insReceipt = raw(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, ?, 'work-claim', 'commons', 'commons', 'Commons', ?, '["human-b"]', NULL, NULL, '{}', ?, 'x')`);
  db.exec("BEGIN");
  for (let i = from; i < to; i++) {
    insReceipt.run(`wcr_${i}`, `Work ${i}`, i % 2 ? '["agent-a"]' : '["someone-else"]', new Date(1700000000000 + i * 1000).toISOString());
  }
  db.exec("COMMIT");
}

// S3 — public board (bench2): published tasks across 50 rooms, each with a
// real claim item seeded through the writer fence.
function seedBoard({ db, store, raw }, from, to) {
  if (from === 0) {
    const roomCols = raw("PRAGMA table_info(rooms)").all().map((r) => r.name);
    const commons = raw("SELECT * FROM rooms WHERE id='commons'").get();
    for (let r = 0; r < 50; r++) {
      const row = { ...commons, id: `room-${r}` };
      const cols = roomCols.filter((c) => c in row);
      raw(`INSERT INTO rooms (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(row);
    }
  }
  const terms = JSON.stringify({
    kind: "task", title: "Task", summary: "s", acceptanceCriteria: ["c"],
    reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
  });
  const insOffer = raw(`INSERT INTO project_offers (offer_id, room_id, owner_id, version, revision, status, terms, private_links, created_at, updated_at)
    VALUES (?, ?, 'owner-1', 1, 1, 'published', ?, '[]', 1700000000, 1700000000)`);
  const insTask = raw(`INSERT INTO public_work_tasks (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?, ?, ?, 1, 'https://example.com/r', 'main', '[]', 0, 1700000000)`);
  db.exec("BEGIN");
  raw("UPDATE public_work_claim_writer_permit SET enabled=1 WHERE singleton=1").run();
  for (let i = from; i < to; i++) {
    const room = `room-${i % 50}`;
    insOffer.run(`offer-${i}`, room, terms);
    insTask.run(`offer-${i}`, room, room);
    store.workClaims.set(room, { id: `offer-${i}`, state: "unclaimed" });
  }
  raw("UPDATE public_work_claim_writer_permit SET enabled=0 WHERE singleton=1").run();
  db.exec("COMMIT");
}

// S4 — fat claim namespace (bench3): claims with 50-stamp histories.
function seedNamespace({ db, store }, from, to) {
  db.exec("BEGIN");
  for (let i = from; i < to; i++) {
    const history = Array.from({ length: 50 }, (_, s) => ({ at: 1700000000000 + s * 1000, actor: "a", action: "note", note: "x" }));
    store.workClaims.set("fat-ns", { id: `claim-${i}`, state: "unclaimed", history });
  }
  db.exec("COMMIT");
}

// S5 — directory of rooms (bench3): public_rooms rows for the sitemap walk.
function seedRooms({ raw, db }, from, to) {
  const insRoom = raw(`INSERT INTO public_rooms (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?, 'T', 'p', 1, 1, '[]', '[]', '[]', 1, 'request', NULL, NULL, '2026-01-01', '2026-01-01')`);
  db.exec("BEGIN");
  for (let i = from; i < to; i++) insRoom.run(`room-${i}`);
  db.exec("COMMIT");
}

// ---------------------------------------------------------------------------
// Budget rows. `at` = the shape size the budget binds at. enforce flips to
// true in the same PR that lands the named fix (see header).

export const BUDGETS = Object.freeze([
  { id: "front-door-statements", surface: "GET /api/public/front-door (frontDoorFacts)", shape: "S1", at: 50000, metric: "statements", budget: 10, enforce: false, fix: "PR #4122 (queued in Wave B)" },
  { id: "receipt-proof-statements", surface: "room proof page, fat room (queryRoomProof)", shape: "S1", at: 50000, metric: "statements", budget: 6, enforce: false, fix: "PR #4122 (queued in Wave B)" },
  { id: "board-list1-statements", surface: "PublicWorkClaims.list({limit:1})", shape: "S3", at: 20000, metric: "statements", budget: 50, enforce: false, fix: "charter C-1 / PERF2-BOARD" },
  { id: "board-page-statements", surface: "PublicWorkClaims.list({limit:20}) board page", shape: "S3", at: 20000, metric: "statements", budget: 100, enforce: false, fix: "charter C-1 / PERF2-BOARD" },
  { id: "sitemap-statements", surface: "listPublicRoomSitemap", shape: "S5", at: 10000, metric: "statements", budget: 20, enforce: false, fix: "charter C-2 / PERF2-SITEMAP" },
  { id: "sitemap-receipt-completeness", surface: "listPublicReceiptSitemap covers every public receipt", shape: "S1", at: 10000, metric: "receiptsMissing", budget: 0, enforce: false, fix: "charter C-2 / PERF2-SITEMAP" },
  { id: "message-post-execs", surface: "message post (store.command, ordinary room)", shape: "CMD", at: 1, metric: "execs", budget: 25, enforce: false, fix: "HOT-PATH PR-1 #4095 (queued in Wave B)" },
]);

// ---------------------------------------------------------------------------

export function runPerfBudgets({ small = false } = {}) {
  const readings = [];   // {surface, shape, size, statements, execs, rowsOut, ms, result}
  const completeness = []; // {check, ok, detail}
  const check = (name, ok, detail) => completeness.push({ check: name, ok: !!ok, detail });

  const s1Sizes = small ? [1000] : [1000, 10000, 50000];
  const s2Sizes = small ? [1000] : [1000, 10000, 50000];
  const s3Sizes = small ? [200] : [200, 1000, 5000, 20000];
  const s4Sizes = small ? [1000] : [1000, 10000, 50000];
  const s5Sizes = small ? [1000] : [1000, 10000];

  // --- S1: receipt corpus surfaces ---
  {
    const ctx = makeStore();
    const counter = makeCounter(ctx.db);
    try { counter.raw(`INSERT INTO agent_directory_cards (agent_id, card_json, visibility, owner_identity_id, withdrawn) VALUES ('agent-a', '{"name":"Agent A","skills":["x"]}', 'public', NULL, 0)`).run(); } catch { /* parity below reports */ }
    let seeded = 0;
    for (const size of s1Sizes) {
      seedReceipts({ db: ctx.db, raw: counter.raw }, seeded, size);
      seeded = size;
      const total = counter.raw("SELECT COUNT(*) AS n FROM public_receipts").get().n;
      check(`S1 fixture size at ${size}`, total === size, `independent COUNT=${total}`);
      const collect = counter.measure(() => collectPublicReceipts(ctx.store));
      readings.push({ surface: "collectPublicReceipts (full collect, by design O(corpus))", shape: "S1", size, ...pick(collect), result: collect.out.length });
      check(`S1 collect returns the corpus at ${size}`, collect.out.length === size, `collect=${collect.out.length}`);
      let body = null;
      const facts = counter.measure(() => frontDoorFacts({
        remoteAddress: "203.0.113.7", store: ctx.store, req: { method: "GET" },
        res: { setHeader: () => {} }, rate: () => {}, json: (res, status, b) => { body = b; },
      }));
      readings.push({ surface: "frontDoorFacts handler", shape: "S1", size, ...pick(facts), result: body?.counters?.receiptsIssued });
      const parityIssued = collect.out.length;
      const parityVerified = collect.out.filter((r) => r.mergedAt && r.pullRequest).length;
      check(`S1 front-door counter parity at ${size}`,
        body?.counters?.receiptsIssued === parityIssued && body?.counters?.resultsVerified === parityVerified,
        `handler issued=${body?.counters?.receiptsIssued} verified=${body?.counters?.resultsVerified}; collect issued=${parityIssued} verified=${parityVerified}`);
      const proof = counter.measure(() => queryRoomProof(ctx.store, "fatroom"));
      readings.push({ surface: "queryRoomProof(fatroom)", shape: "S1", size, ...pick(proof), result: proof.out.length });
      const page = counter.measure(() => (queryPublicReceipts(ctx.store, { agent: "agent-a", limit: 20 }).receipts ?? []).length);
      readings.push({ surface: "queryPublicReceipts agent page(20)", shape: "S1", size, ...pick(page), result: page.out });
      if (size >= 10000) {
        const sitemap = counter.measure(() => listPublicReceiptSitemap(ctx.store));
        readings.push({ surface: "listPublicReceiptSitemap (default limit)", shape: "S1", size, ...pick(sitemap), result: sitemap.out.length, receiptsMissing: size - sitemap.out.length });
      }
    }
    ctx.store.close();
  }

  // --- S2: directory write path ---
  {
    const ctx = makeStore();
    const counter = makeCounter(ctx.db);
    counter.raw(`INSERT INTO agent_directory_cards (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn)
      VALUES ('agent-a', '{"name":"Agent A","skills":["x"]}', 'public', 'ident-1', 1700000000, 1700000000, 0)`).run();
    let seeded = 0;
    for (const size of s2Sizes) {
      seedDirectory({ db: ctx.db, raw: counter.raw }, seeded, size);
      seeded = size;
      const total = counter.raw("SELECT COUNT(*) AS n FROM public_receipts").get().n;
      check(`S2 fixture size at ${size}`, total === size, `independent COUNT=${total}`);
      counter.measure(() => syncDirectoryCard(ctx.store, "agent-a")); // warm
      const sync = counter.measure(() => syncDirectoryCard(ctx.store, "agent-a"));
      readings.push({ surface: "syncDirectoryCard(agent-a) [write path]", shape: "S2", size, ...pick(sync), result: "ok" });
      const entry = counter.raw("SELECT receipt_count FROM public_directory_entries WHERE agent_id='agent-a'").get();
      const expected = counter.raw("SELECT COUNT(*) AS n FROM public_receipts WHERE agents_json LIKE '%agent-a%'").get().n;
      check(`S2 directory count parity at ${size}`, entry?.receipt_count === expected, `card=${entry?.receipt_count} independent=${expected}`);
    }
    ctx.store.close();
  }

  // --- S3: public board ---
  {
    const ctx = makeStore();
    const counter = makeCounter(ctx.db);
    let seeded = 0;
    for (const size of s3Sizes) {
      seedBoard({ db: ctx.db, store: ctx.store, raw: counter.raw }, seeded, size);
      seeded = size;
      const published = counter.raw("SELECT COUNT(*) AS n FROM project_offers WHERE status='published'").get().n;
      check(`S3 fixture size at ${size}`, published === size, `independent COUNT=${published}`);
      const list1 = counter.measure(() => ctx.store.publicWorkClaims.list({ limit: 1 }).claimableCount);
      readings.push({ surface: "list({limit:1}) [front-door claimableCount]", shape: "S3", size, ...pick(list1), result: list1.out });
      check(`S3 claimableCount parity at ${size}`, list1.out === size, `list=${list1.out} seeded unclaimed=${size}`);
      const page = counter.measure(() => ctx.store.publicWorkClaims.list({ limit: 20 }).tasks.length);
      readings.push({ surface: "list({limit:20}) [board page]", shape: "S3", size, ...pick(page), result: page.out });
    }
    ctx.store.close();
  }

  // --- S4: fat namespace sweep (recommend() multiplier shape) ---
  {
    const ctx = makeStore();
    const counter = makeCounter(ctx.db);
    let seeded = 0;
    for (const size of s4Sizes) {
      seedNamespace({ db: ctx.db, store: ctx.store }, seeded, size);
      seeded = size;
      const listed = counter.measure(() => ctx.store.workClaims.list("fat-ns"));
      check(`S4 fixture size at ${size}`, listed.out.length === size, `workClaims.list=${listed.out.length}`);
      const swept = counter.measure(() => releaseExpired(listed.out, Date.now()));
      readings.push({ surface: "workClaims.list + releaseExpired sweep (one namespace)", shape: "S4", size, statements: listed.statements + swept.statements, execs: listed.execs + swept.execs, rowsOut: listed.rowsOut, ms: Math.round((listed.ms + swept.ms) * 10) / 10, result: swept.out.length });
    }
    ctx.store.close();
  }

  // --- S5: sitemap room walk ---
  {
    const ctx = makeStore();
    const counter = makeCounter(ctx.db);
    let seeded = 0;
    for (const size of s5Sizes) {
      seedRooms({ raw: counter.raw, db: ctx.db }, seeded, size);
      seeded = size;
      const total = counter.raw("SELECT COUNT(*) AS n FROM public_rooms").get().n;
      check(`S5 fixture size at ${size}`, total === size, `independent COUNT=${total}`);
      const walk = counter.measure(() => listPublicRoomSitemap(ctx.store));
      readings.push({ surface: "listPublicRoomSitemap", shape: "S5", size, ...pick(walk), result: walk.out.length });
      check(`S5 sitemap returns every seeded room at ${size}`, walk.out.length === size, `rows=${walk.out.length}`);
    }
    ctx.store.close();
  }

  // --- CMD: message post op count (ordinary room, no receipt opt-in) ---
  {
    const ctx = makeStore();
    const key = ctx.store.issueAccessKey("commons", "owner");
    const counter = makeCounter(ctx.db);
    const posted = counter.measure(() => ctx.store.command(key, "commons", {
      id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "perf-budget-msg-1", body: "budget probe" },
    }));
    readings.push({ surface: "store.command message.posted [ordinary room]", shape: "CMD", size: 1, ...pick(posted), result: posted.out?.type ?? "ok" });
    let stored = null;
    try { stored = counter.raw("SELECT COUNT(*) AS n FROM messages WHERE message_id='perf-budget-msg-1'").get()?.n; } catch { /* reported below */ }
    check("CMD message post landed exactly one message", stored === 1, `independent messages count=${stored}`);
    ctx.store.close();
  }

  // --- Budget evaluation (full shapes only) ---
  const budgets = BUDGETS.map((row) => {
    const reading = readings.find((r) => r.shape === row.shape && r.size === row.at && surfaceMatches(row, r));
    if (!reading) return { ...row, value: null, status: small ? "not-evaluated-small" : "not-evaluated" };
    const value = row.metric === "receiptsMissing" ? (reading.receiptsMissing ?? null) : reading[row.metric];
    return { ...row, value, status: value == null ? "not-evaluated" : value <= row.budget ? "within" : "BREACH" };
  });

  const completenessOk = completeness.every((c) => c.ok);
  return { readings, completeness, budgets, completenessOk, small };
}

function surfaceMatches(row, reading) {
  if (row.id === "front-door-statements") return reading.surface.startsWith("frontDoorFacts");
  if (row.id === "receipt-proof-statements") return reading.surface.startsWith("queryRoomProof");
  if (row.id === "board-list1-statements") return reading.surface.startsWith("list({limit:1})");
  if (row.id === "board-page-statements") return reading.surface.startsWith("list({limit:20})");
  if (row.id === "sitemap-statements") return reading.surface.startsWith("listPublicRoomSitemap");
  if (row.id === "sitemap-receipt-completeness") return reading.surface.startsWith("listPublicReceiptSitemap");
  if (row.id === "message-post-execs") return reading.surface.startsWith("store.command");
  return false;
}

function pick(measured) {
  return { statements: measured.statements, execs: measured.execs, rowsOut: measured.rowsOut, ms: Math.round(measured.ms * 10) / 10 };
}

// ---------------------------------------------------------------------------

function printReport(report) {
  console.log("PERF-2 deterministic budgets (statements/execs transfer to workerd; Node ms are curve shape only)\n");
  let lastShape = "";
  for (const r of report.readings) {
    if (r.shape !== lastShape) { console.log(`\n[${r.shape}]`); lastShape = r.shape; }
    console.log(`  ${r.surface} @${r.size}: statements=${r.statements} execs=${r.execs} rowsOut=${r.rowsOut} ms=${r.ms} result=${r.result}${r.receiptsMissing != null ? ` receiptsMissing=${r.receiptsMissing}` : ""}`);
  }
  console.log("\nBudgets (PERF-2 programme §1):");
  for (const b of report.budgets) {
    console.log(`  ${b.status === "BREACH" ? "✗" : b.status === "within" ? "✓" : "·"} ${b.id}: ${b.metric}=${b.value ?? "—"} vs budget ${b.budget} @${b.shape}${b.at} [${b.status}${b.enforce ? ", enforced" : ", tracked"}; fix: ${b.fix}]`);
  }
  console.log("\nCompleteness checks:");
  for (const c of report.completeness) console.log(`  ${c.ok ? "✓" : "✗ FAIL"} ${c.check} — ${c.detail}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const small = args.includes("--small");
  const checkAll = args.includes("--check");
  const report = runPerfBudgets({ small });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.completenessOk) { console.error("\nCOMPLETENESS FAILURE — the instrument under-captured; readings above are not trustworthy."); process.exit(2); }
  const breaches = report.budgets.filter((b) => b.status === "BREACH" && (checkAll || b.enforce));
  if (breaches.length) { console.error(`\nBUDGET BREACH (${checkAll ? "--check: all rows" : "enforced rows"}): ${breaches.map((b) => b.id).join(", ")}`); process.exit(3); }
}
