// scripts/routing-eval.mjs — affinity router backtest + shadow metrics (lane B18, D6 §4.2).
//
// SHADOW EVALUATION ONLY. Lane behavior is ground truth; the router is the
// hypothesis under test. Nothing here claims, routes, or promotes — metrics
// are printed for human review. Weight re-fitting (--refit) prints suggested
// weights; it NEVER writes routing-config.json (D6: re-fit reviewed by a
// human before adoption).
//
// Usage:
//   node scripts/routing-eval.mjs --synthetic 200
//   node scripts/routing-eval.mjs --history cases.json [--refit]
//   node scripts/routing-eval.mjs --db room.sqlite [--room room-id] [--limit 200]
// cases.json: [{ workItem, lanes, boardState, eventualClaimant, at? }]

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, evaluateBacktest, DEFAULT_CONFIG, SHADOW_MODE } from "../server/routing.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const loadConfig = () => {
  try {
    return JSON.parse(readFileSync(join(repoRoot, "server/routing-config.json"), "utf8"));
  } catch {
    return DEFAULT_CONFIG;
  }
};

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "1");
};

// --- synthetic case generator (planted affinity; smoke-tests the metrics) -----
const AREAS = [
  { files: ["server/work-claims.mjs"], tags: ["claims-board"] },
  { files: ["server/queue.mjs"], tags: ["queue"] },
  { files: ["src/board-ui.js"], tags: ["ui"] },
  { files: ["server/bonds.mjs"], tags: ["bonds"] },
];
const LANES = ["quill", "codex", "fo", "grokbot", "instinct"];
const rnd = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(42);
const pick = arr => arr[Math.floor(rnd() * arr.length)];

function syntheticCases(n, now) {
  const cases = [];
  for (let i = 0; i < n; i++) {
    const area = pick(AREAS);
    const doer = pick(LANES);
    const lanes = LANES.map(id => {
      const isDoer = id === doer;
      return {
        id,
        openClaims: isDoer && rnd() < 0.6 ? [{ id: `RC-s${i}`, files: area.files }] : [],
        mergedPRs: isDoer ? [{ number: 1000 + i, files: area.files, mergedAt: now - Math.floor(rnd() * 20) * 86_400_000 }] : [],
        completedClaims: isDoer
          ? [{ id: `D${i}`, title: `work on ${area.tags[0]} area`, files: area.files, tags: area.tags, completedAt: now - 5 * 86_400_000 }]
          : [],
        claimsWindow30d: [],
        cap: 20,
      };
    });
    cases.push({
      workItem: { taskId: `RC-eval-${i}`, title: `fix ${area.tags[0]} bug`, brief: `a bug in the ${area.tags[0]} area`, files: area.files, tags: area.tags },
      lanes,
      boardState: { claims: [], freshAt: now },
      eventualClaimant: doer,
      at: now,
    });
  }
  return cases;
}

// --- historical reconstruction from a room sqlite db ---------------------------
// Reads the work_claims table (room_id, claim_id, item_json, updated_at).
// For each done claim with an owner, reconstructs the board at claim time from
// claims whose updated_at <= its claimedAt. PR history is NOT in the board —
// prRecency is reported as unavailable (signal coverage below), never invented.
function casesFromDb(dbPath, { roomId = null, limit = 200 } = {}) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(
    `SELECT room_id, claim_id, item_json, updated_at FROM work_claims ${roomId ? "WHERE room_id = ?" : ""} ORDER BY updated_at ASC ${roomId ? "" : ""}`
  ).all(...(roomId ? [roomId] : []));
  const items = rows.map(r => {
    try { return { ...JSON.parse(r.item_json), _updated: r.updated_at, _room: r.room_id }; }
    catch { return null; }
  }).filter(Boolean);
  const done = items.filter(c => c.state === "done" && c.owner && c.claimedAt).slice(-limit);
  const cases = [];
  for (const d of done) {
    const at = d.claimedAt;
    const prior = items.filter(c => (c._updated ?? 0) <= at && c.id !== d.id);
    const claims = prior.map(c => ({
      id: c.id, title: c.title, state: c.state, owner: c.owner ?? null,
      files: c.files ?? [], tags: c.tags ?? [], claimedAt: c.claimedAt ?? null,
      completedAt: c.state === "done" ? (c._updated ?? null) : null,
    }));
    const lanes = [...new Set(claims.map(c => c.owner).filter(Boolean))].map(id => ({
      id,
      openClaims: [], // historical open-set at time t is approximated below
      completedClaims: [],
      claimsWindow30d: [],
      cap: 20,
    }));
    // Approximate: claims updated within 24h before t and not done → open at t.
    const laneMap = new Map(lanes.map(l => [l.id, l]));
    for (const c of claims) {
      const L = laneMap.get(c.owner);
      if (!L) continue;
      if (["claimed", "in_progress", "blocked"].includes(c.state) && at - (c._updated ?? 0) < 86_400_000) {
        L.openClaims.push({ id: c.id, files: c.files });
      }
      if (c.state === "done") L.completedClaims.push({ id: c.id, title: c.title, files: c.files, tags: c.tags, completedAt: c.completedAt });
      if (c.claimedAt && at - c.claimedAt <= 30 * 86_400_000) L.claimsWindow30d.push({ id: c.id, state: c.state, claimedAt: c.claimedAt });
    }
    cases.push({
      workItem: { taskId: d.id, title: d.title ?? d.id, brief: null, files: d.files ?? [], tags: d.tags ?? [] },
      lanes, boardState: { claims, freshAt: at }, eventualClaimant: d.owner, at,
    });
  }
  db.close();
  return cases;
}

// --- metrics table (D6 §4.2, pre-registered; goalposts don't move) --------------
function reportMetrics(m, { label }) {
  const gate = m.precisionAt3 >= 0.70 ? "PASS" : "below gate";
  console.log(`\n== routing shadow eval: ${label} ==`);
  console.log(`shadow mode: ${SHADOW_MODE} (no promotion path in this harness)`);
  console.log(`cases:            ${m.n} (ranked ${m.ranked}, eventual claimant unranked ${m.unranked})`);
  console.log(`top-1 hit rate:   ${(m.precisionAt1 * 100).toFixed(1)}%`);
  console.log(`top-3 hit rate:   ${(m.precisionAt3 * 100).toFixed(1)}%   gate: ≥70% → ${gate}`);
  console.log(`mean recip rank:  ${m.mrr.toFixed(3)}`);
  console.log(`signal coverage:  prRecency unavailable from board history (needs PR-history source, D6 open Q2)`);
  console.log(`duplicate delta:  not measurable in backtest — track live vs pre-router baseline (hard stop if it rises)`);
  return m;
}

// --- weight re-fit: coordinate ascent on top-3 hit rate --------------------------
// Prints suggested weights for HUMAN REVIEW. Never writes config.
function refit(cases, config) {
  const keys = ["fileClaimOverlap", "prRecency", "capabilityMatch", "keywordOverlap"];
  const negKeys = ["loadPenalty", "leaseHealthPenalty"];
  const base = { ...config.ROUTING_WEIGHTS };
  const score = w => {
    const cfg = { ...config, ROUTING_WEIGHTS: { ...config.ROUTING_WEIGHTS, ...w } };
    let hits = 0;
    for (const c of cases.slice(0, 400)) {
      const rec = decide({ workItem: c.workItem, lanes: c.lanes, boardState: c.boardState, ctx: { ...(c.ctx ?? {}), config: cfg, now: c.at ?? Date.now() }, now: c.at ?? Date.now(), routingId: "refit" });
      if (rec.candidates.slice(0, 3).some(x => x.lane === c.eventualClaimant)) hits++;
    }
    return hits / Math.max(1, Math.min(cases.length, 400));
  };
  const w = { ...base };
  let best = score(w);
  for (let round = 0; round < 6; round++) {
    let moved = false;
    for (const k of keys) {
      for (const d of [0.05, -0.05]) {
        const trial = { ...w, [k]: Math.min(0.6, Math.max(0, +(w[k] + d).toFixed(2))) };
        const s = score(trial);
        if (s > best + 1e-9) { Object.assign(w, trial); best = s; moved = true; }
      }
    }
    for (const k of negKeys) {
      for (const d of [-0.05, 0.05]) {
        const trial = { ...w, [k]: Math.max(-0.6, Math.min(0, +(w[k] + d).toFixed(2))) };
        const s = score(trial);
        if (s > best + 1e-9) { Object.assign(w, trial); best = s; moved = true; }
      }
    }
    if (!moved) break;
  }
  console.log("\n== weight re-fit (coordinate ascent, top-3 hit rate) ==");
  console.log("HUMAN REVIEW REQUIRED — these are NOT applied. Weight changes are");
  console.log("journaled as config records, never silent edits (D6 §4.2).");
  console.log(`base top-3: ${(score(base) * 100).toFixed(1)}% → fitted top-3: ${(best * 100).toFixed(1)}%`);
  for (const k of [...keys, ...negKeys]) {
    const delta = +(w[k] - base[k]).toFixed(2);
    console.log(`  ${k}: ${base[k]} → ${w[k]}  (Δ ${delta >= 0 ? "+" : ""}${delta})${Math.abs(delta) > 0.05 ? "  ← >0.05, review" : ""}`);
  }
  console.log(JSON.stringify({ ROUTING_WEIGHTS: w }, null, 2));
}

const main = () => {
  const config = loadConfig();
  const now = Date.now();
  let cases;
  let label;
  if (flag("--synthetic")) {
    const n = parseInt(flag("--synthetic"), 10) || 200;
    cases = syntheticCases(n, now);
    label = `synthetic n=${n}`;
  } else if (flag("--history")) {
    cases = JSON.parse(readFileSync(flag("--history"), "utf8"));
    label = `history file (${cases.length} cases)`;
  } else if (flag("--db")) {
    cases = casesFromDb(flag("--db"), { roomId: flag("--room"), limit: parseInt(flag("--limit") || "200", 10) });
    label = `db ${flag("--db")} (${cases.length} done claims)`;
  } else {
    console.error("usage: node scripts/routing-eval.mjs --synthetic N | --history cases.json [--refit] | --db room.sqlite [--room id] [--limit 200]");
    process.exit(2);
  }
  if (cases.length === 0) { console.error("no cases — nothing to evaluate"); process.exit(1); }
  const withCfg = cases.map(c => ({ ...c, ctx: { ...(c.ctx ?? {}), config } }));
  const m = reportMetrics(evaluateBacktest(withCfg, { topK: 3 }), { label });
  if (flag("--refit")) {
    if (!flag("--history")) { console.error("--refit needs --history (reproducible dataset)"); process.exit(2); }
    refit(withCfg, config);
  }
  process.exit(m.precisionAt3 >= 0.70 ? 0 : 3); // exit 3 = below gate, not a crash
};

main();
