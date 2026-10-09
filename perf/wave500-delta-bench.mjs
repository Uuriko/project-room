// WAVE-500 W5 — delta board cursor benchmark.
// Measures wire bytes of a full board poll vs `?since=` delta polls on a
// 200-claim board, for steady-state (0 changes), 2 changes, and 50 changes.
//
// W4's delta implementation had NOT landed in this base at measurement time
// (no boardSeq anywhere in server/). So this bench is contract-based:
//  - FULL side: the real production page builder, buildWorkClaimPage from
//    server/work-claim-routes.mjs — the exact code path that serves board
//    polls today. (The F3 contract adds one top-level `boardSeq` field to the
//    full page, ~14 bytes; noted in the results, not measured here.)
//  - DELTA side: a contract-faithful encoder that runs the repo's OWN
//    projection pipeline (summarizeClaimHistory + stampClaimPage) and
//    implements ONLY the F3 delta branch from the design doc
//    (docs/WAVE300-FANOUT-DESIGN.md, F3): filter boardSeq > since, sort by
//    boardSeq ascending (mutation order, id tiebreak), top-level boardSeq,
//    room-wide openClaims/terminalClaims counts, per-claim boardSeq kept,
//    historyScope "delta", hasMore false, nextCursor null.
//
// Fidelity: the delta encoder was validated byte-identical against the only
// landed F3 implementation (the wave300-fanout-perf branch, which carries
// the same F3 design) over identical fixtures before these numbers were
// taken. See docs/WAVE500-DELTA.md for the validation note.
//
// Run: TMPDIR=$PWD/.tmp node perf/wave500-delta-bench.mjs
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import {
  createWork, claimWork, updateWork, attestWork, recordReview,
  summarizeClaimHistory, isTerminalClaimState, STATES, ACTIVE_CLAIM_STATES,
} from "../server/work-claims.mjs";
import { buildWorkClaimPage } from "../server/work-claim-routes.mjs";
import { stampClaimPage } from "../server/content-trust.mjs";
import { LIST_HISTORY_ENTRIES } from "../server/work-claim-integrity.mjs";

const ROOM = "bench-room";
const VIEWER = "bench-viewer";
const NOW = Date.parse("2026-10-08T20:00:00.000Z");
const BOARD_SIZE = 200;
const LIMIT = 50; // BOARD_LIMIT_DEFAULT in work-claim-routes.mjs

// Deterministic fixtures: mulberry32.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  "ship room trydemigod.com deploy lane", "audit project-room board v2 removal",
  "write swarm plug-in doc section", "fix claim lease expiry sweep", "add nebula importer draft",
  "profile SSE pump under write load", "harden mutation test gaps", "review PR queue triage",
  "design $DASHA sink mechanics", "teardown competitor onboarding funnel",
];
const NOTES = [
  "first pass landed, needs review", "repro confirmed on main, fix in progress",
  "waiting on lane ACK before merge", "evidence attached in history",
  "followed the room playbook, no collisions", "swept by the lease watchdog",
  "paired with the concierge crew", "needs a second pair of eyes",
];
const TAGS = ["fast", "hard", "docs", "infra", "qa", "ux", "money", "perf"];
const FILES = ["server/http.mjs", "server/work-claims.mjs", "docs/SWARM-PLUG-IN.md",
  "client/board.js", "tests/work-claim-board.test.js", "ops/deploy.sh"];
const LANES = ["quill", "grok", "codex", "fo", "instinct", "jill", "tab", "dot"];
const STATES_WEIGHTED = ["claimed", "claimed", "claimed", "claimed",
  "in_progress", "in_progress", "in_progress", "unclaimed", "unclaimed",
  "done", "done", "blocked", "verified", "delivered"];

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const maybe = (r, p) => r() < p;

// Build a 200-claim board with realistic shapes and history, then stamp each
// stored row with a monotonic boardSeq exactly as an F3 registry's set()
// would (bumped inside the same write as the mutation).
function buildBoardSeeded(seed) {
  const r = rng(seed);
  const items = [];
  let seq = 0;
  const stamp = item => ({ ...item, boardSeq: ++seq });
  for (let i = 0; i < BOARD_SIZE; i++) {
    const id = `w${String(i).padStart(3, "0")}`;
    const lane = pick(r, LANES);
    const t = NOW - Math.floor(r() * 6 * 86400) * 1000;
    let item = createWork({
      id,
      title: `${pick(r, TITLES)} [${id}]`,
      note: pick(r, NOTES),
      tags: [pick(r, TAGS), pick(r, TAGS)].filter((v, k, a) => a.indexOf(v) === k),
      files: [pick(r, FILES)],
      reviewPolicy: maybe(r, 0.3) ? "distinct_member" : undefined,
    }, { now: t, agentId: lane });
    const target = pick(r, STATES_WEIGHTED);
    if (target !== "unclaimed") {
      item = claimWork(item, lane, { note: pick(r, NOTES), now: t + 3600 * 1000 });
      const steps = Math.floor(r() * 3);
      for (let s = 0; s < steps; s++) {
        if (maybe(r, 0.5)) item = attestWork(item, lane, { note: pick(r, NOTES), now: t + (s + 2) * 3600 * 1000 });
        else item = recordReview(item, pick(r, LANES.filter(l => l !== lane)), { verdict: "approve", summary: pick(r, NOTES), now: t + (s + 2) * 3600 * 1000 });
      }
      if (target !== "claimed" && target !== "in_progress") {
        try {
          item = updateWork(item, lane, { state: target, note: pick(r, NOTES), now: t + 5 * 3600 * 1000, authority: true });
        } catch { /* illegal transition for this fixture: keep claimed/in_progress */ }
      }
    }
    items.push(stamp(item));
  }
  return { items, seq };
}

// Simulate F3 registry set(): re-stamp the mutated claims with fresh seqs.
function mutate(items, ids, fn) {
  let seq = Math.max(...items.map(i => i.boardSeq ?? 0));
  const byId = new Map(items.map(i => [i.id, i]));
  for (const id of ids) {
    const cur = byId.get(id);
    byId.set(id, { ...fn(cur), boardSeq: ++seq });
  }
  return { items: [...byId.values()], seq };
}

const stripClaimSeq = item => {
  if (!item || !Object.hasOwn(item, "boardSeq")) return item;
  const { boardSeq: _dropped, ...rest } = item;
  return rest;
};

// Contract-faithful F3 delta encoder (see header for the fidelity note).
function buildDeltaPage(items, since, seqNow, nowMs = NOW) {
  const metadata = {
    roomId: ROOM, source: "work-claims", evaluatedAt: new Date(nowMs).toISOString(),
    consistency: "live", limit: LIMIT, historyLimit: LIST_HISTORY_ENTRIES,
  };
  const changed = items
    .filter(item => (item.boardSeq ?? 0) > since)
    .sort((a, b) => ((a.boardSeq ?? 0) - (b.boardSeq ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const openClaims = items.filter(item => !isTerminalClaimState(item.state)).length;
  const page = {
    claims: changed, hasMore: false, nextCursor: null,
    openClaims, terminalClaims: items.length - openClaims, historyScope: "delta",
  };
  const projected = page.claims.map(item => summarizeClaimHistory(item, LIST_HISTORY_ENTRIES));
  return stampClaimPage({ ...metadata, ...page, boardSeq: seqNow, claims: projected }, VIEWER);
}

const bytesOf = page => Buffer.byteLength(JSON.stringify(page), "utf8");
const gzipBytesOf = page => gzipSync(Buffer.from(JSON.stringify(page), "utf8")).length;
const kb = n => (n / 1024).toFixed(1);

function scenario(label, changedCount) {
  let { items, seq } = buildBoardSeeded(0xC0FFEE);
  const seqNow0 = seq;
  if (changedCount > 0) {
    const ids = [];
    const r = rng(0xDE17A + changedCount);
    // Only active claims can take an attestation; the churn mutates those.
    const pool = items.filter(i => ACTIVE_CLAIM_STATES.includes(i.state));
    while (ids.length < changedCount && pool.length > 0) {
      ids.push(pool.splice(Math.floor(r() * pool.length), 1)[0].id);
    }
    const res = mutate(items, ids, item =>
      attestWork(item, item.owner ?? "quill", { note: "steady poll churn note", now: NOW }));
    items = res.items; seq = res.seq;
  }
  // Full page: real production builder, whole board in one poll (limit=200 is
  // BOARD_LIMIT_MAX — the "full re-download" the design's ~145KB figure
  // refers to). Contract strips per-claim boardSeq from full pages, so
  // strip here for a byte-fair baseline.
  const fullItems = items.map(stripClaimSeq);
  const full = buildWorkClaimPage(fullItems, ROOM, VIEWER, new URLSearchParams("limit=200"), NOW);
  const delta = buildDeltaPage(items, seqNow0, seq);
  const fullB = bytesOf(full);
  const deltaB = bytesOf(delta);
  return {
    label, changed: changedCount, claims: items.length, seqNow: seq,
    fullBytes: fullB, fullGzip: gzipBytesOf(full),
    deltaBytes: deltaB, deltaGzip: gzipBytesOf(delta),
    deltaClaims: delta.claims.length,
    ratio: fullB / deltaB,
  };
}

const results = [
  scenario("steady-state (0 changes)", 0),
  scenario("2 claims changed", 2),
  scenario("50 claims changed", 50),
];

console.log("# WAVE-500 W5 delta cursor benchmark");
console.log(`# 200-claim board, poller cursor = boardSeq after initial full page`);
console.log("");
console.log("| scenario | full page | delta | ratio (full/delta) | delta claims |");
console.log("|---|---|---|---|---|");
for (const r of results) {
  console.log(`| ${r.label} | ${kb(r.fullBytes)} KB (${kb(r.fullGzip)} KB gz) | ${kb(r.deltaBytes)} KB (${kb(r.deltaGzip)} KB gz) | ${r.ratio.toFixed(1)}x | ${r.deltaClaims} |`);
}
console.log("");
console.log("## raw (bytes)");
console.log(JSON.stringify(results, null, 2));
