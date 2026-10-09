#!/usr/bin/env node
// capacity-digest.mjs — FIX-55: surface board-capacity + CI queue-depth gauges in-room.
//
// Builds a compact 15-minute capacity digest from two inputs:
//   board   — open work-claim count vs the room's open-claim cap
//             (default 200, the DEFAULT_MAX_OPEN_CLAIMS in server/work-claims.mjs)
//   ciQueue — the latest `ci.queue_depth_sample` record from the FIX-22c
//             emitter (telemetry/ci-queue/), carrying queued/running/p50_wait_s
//             and the rho>1 knee verdict.
//
// The computation is pure: buildDigest({ board, ciQueue, now }) -> digest.
// The posting transport is opt-in only (--post + CAPACITY_DIGEST_WEBHOOK_URL);
// default runs print the digest to stdout and touch nothing external.
// Tests run offline on fixtures: node --test tests/capacity-digest.test.js
//
// Usage:
//   node scripts/capacity-digest.mjs --board-fixture ./board.json --ci-log ./telemetry/ci-queue/samples.jsonl
//   node scripts/capacity-digest.mjs --board-url https://room.trydemigod.com/api/rooms/muse-room/work-claims?limit=200 \
//        --ci-fixture ./sample.json --post        # requires CAPACITY_DIGEST_WEBHOOK_URL
//
// Board fixture/url shape: { claims: [{ state, ... }] } or { open: <n>, cap?: <n> }.
//   Open = non-terminal claim states (unclaimed, claimed, in_progress, blocked);
//   done/closed are terminal and do not count against the cap.

import fs from "node:fs";
import path from "node:path";

// --- constants ------------------------------------------------------------

// Mirrors server/work-claims.mjs DEFAULT_MAX_OPEN_CLAIMS. A room may configure
// a different cap; pass --cap / board.cap to override. Kept in sync by the
// tests/capacity-digest.test.js default-cap test.
export const BOARD_CAP_DEFAULT = 200;
// Warn when the board is this full (fraction of cap) even before FULL.
export const BOARD_HIGH_PCT = 0.85;
// Non-terminal claim states: these count against the open-claim cap.
export const OPEN_CLAIM_STATES = Object.freeze(["unclaimed", "claimed", "in_progress", "blocked"]);
const TERMINAL_CLAIM_STATES = Object.freeze(["done", "closed"]);

// --- board normalization ---------------------------------------------------

export function countOpenClaims(claims) {
  if (!Array.isArray(claims)) return 0;
  return claims.filter((c) => c && !TERMINAL_CLAIM_STATES.includes(c.state)).length;
}

// Accepts { claims: [...] } (counted), { open: n } / { openClaims: n }
// (taken as-is), and an optional cap override. Returns { open, cap, claims? }.
export function normalizeBoard(input) {
  const src = input ?? {};
  const cap =
    Number.isSafeInteger(src.cap) && src.cap > 0 ? src.cap : BOARD_CAP_DEFAULT;
  let open;
  let claims;
  if (Array.isArray(src.claims)) {
    claims = src.claims;
    open = countOpenClaims(claims);
  } else if (Number.isSafeInteger(src.open) && src.open >= 0) {
    open = src.open;
  } else if (Number.isSafeInteger(src.openClaims) && src.openClaims >= 0) {
    open = src.openClaims;
  } else {
    open = 0;
  }
  return { open, cap, ...(claims ? { claims } : {}) };
}

// --- CI queue normalization -------------------------------------------------

// Accepts a `ci.queue_depth_sample`-shaped record (FIX-22c schema) or null.
// Idempotent: its own output passes through unchanged. Returns the gauge
// fields the digest needs, or null when there is no data.
// A missing knee verdict is not invented: kneeAlert is null, never alerting.
export function normalizeCiQueue(input) {
  if (!input || typeof input !== "object") return null;
  // Already normalized (e.g. buildDigest called on normalizeCiQueue output).
  if ("kneeAlert" in input && !("knee" in input)) return input;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const knee = input.knee && typeof input.knee === "object" ? input.knee : null;
  return {
    queued: num(input.queued) ?? 0,
    running: num(input.running),
    p50WaitS: num(input.p50_wait_s),
    maxWaitS: num(input.max_wait_s),
    kneeAlert: knee ? knee.alert === true : null,
    rhoHat: knee && typeof knee.rho_hat === "number" ? knee.rho_hat : null,
    kneeReason: knee && typeof knee.reason === "string" ? knee.reason : null,
    timestamp: typeof input.timestamp === "string" ? input.timestamp : null,
    repo: typeof input.repo === "string" ? input.repo : null,
  };
}

// --- formatting ------------------------------------------------------------

function fmtWait(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  // Minutes stay minutes (matches the FIX-22c emitter's own "135-minute median
  // wait" phrasing); queue waits read better unconverted.
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

function fmtTs(iso) {
  try {
    return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return String(iso);
  }
}

// --- digest -----------------------------------------------------------------

// Pure computation: no I/O, no network. Returns
// { text, alerts: [{kind, level, detail}], gauges, generatedAt }.
export function buildDigest({ board, ciQueue, now } = {}) {
  const b = normalizeBoard(board);
  const ci = normalizeCiQueue(ciQueue);
  const generatedAt = now ? fmtTs(now instanceof Date ? now.toISOString() : now) : fmtTs(new Date().toISOString());

  const pct = b.cap > 0 ? b.open / b.cap : 0;
  const full = b.open >= b.cap;
  const high = !full && pct >= BOARD_HIGH_PCT;

  const alerts = [];
  if (full) {
    alerts.push({
      kind: "board_full",
      level: "critical",
      detail: `board at cap: ${b.open}/${b.cap} open claims — backpressure: pause new claims and drain before spawning more workers`,
    });
  } else if (high) {
    alerts.push({
      kind: "board_high",
      level: "warn",
      detail: `board ${(pct * 100).toFixed(0)}% full (${b.open}/${b.cap} open claims) — approaching cap`,
    });
  }
  if (ci && ci.kneeAlert === true) {
    const rho = ci.rhoHat !== null ? ` (ρ̂ ${ci.rhoHat.toFixed(2)} > 1)` : "";
    alerts.push({
      kind: "ci_knee",
      level: "critical",
      detail: `CI queue past the knee${rho}${ci.kneeReason ? ` — ${ci.kneeReason}` : ""} — runner-capacity decision owed (FIX-22)`,
    });
  }

  const lines = [];
  lines.push(`📊 capacity digest · ${generatedAt}`);
  lines.push(
    `board: ${b.open}/${b.cap} open claims (${(pct * 100).toFixed(0)}%)${full ? " — FULL" : ` — ${Math.max(0, b.cap - b.open)} slots free`}`
  );
  if (ci) {
    const running = ci.running !== null ? ` · ${ci.running} running` : "";
    lines.push(`ci queue: ${ci.queued} queued${running} · p50 wait ${fmtWait(ci.p50WaitS)}`);
    if (ci.kneeAlert === true) lines.push(`🚨 KNEE ALERT: queue diverging${ci.rhoHat !== null ? `, ρ̂ ${ci.rhoHat.toFixed(2)} > 1` : ""}${ci.kneeReason ? ` — ${ci.kneeReason}` : ""}`);
  } else {
    lines.push("ci queue: no CI data (emitter not reporting)");
  }
  if (full) lines.push("🚨 board FULL — backpressure: pause new claims, drain before spawning workers");
  else if (high) lines.push(`⚠️ board ${(pct * 100).toFixed(0)}% full — approaching cap`);
  if (alerts.length === 0) lines.push("✅ no alerts");

  return {
    text: lines.join("\n"),
    alerts,
    gauges: {
      board: { open: b.open, cap: b.cap, pct: Math.round(pct * 100) / 100, full, high },
      ci: ci
        ? {
            queued: ci.queued,
            running: ci.running,
            p50WaitS: ci.p50WaitS,
            maxWaitS: ci.maxWaitS,
            kneeAlert: ci.kneeAlert,
            rhoHat: ci.rhoHat,
            timestamp: ci.timestamp,
          }
        : null,
    },
    generatedAt,
  };
}

// --- posting transport (opt-in) ---------------------------------------------

// POSTs the digest payload as JSON to a webhook URL. The caller supplies the
// URL (normally via CAPACITY_DIGEST_WEBHOOK_URL); fetchImpl is injectable so
// tests never touch the network. Throws on missing URL — never a silent misfire.
export async function postDigest(digest, { url, token, fetchImpl } = {}) {
  if (!url) throw new Error("postDigest needs a webhook url (set CAPACITY_DIGEST_WEBHOOK_URL or pass --post with the env configured)");
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("no fetch implementation available");
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      text: digest.text,
      alerts: digest.alerts,
      gauges: digest.gauges,
      generatedAt: digest.generatedAt,
    }),
  });
  return { ok: !!res.ok, status: res.status };
}

// --- sources ------------------------------------------------------------------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readLastJsonlLine(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

async function fetchBoard(url, token) {
  const res = await globalThis.fetch(url, {
    headers: { "user-agent": "capacity-digest/1.0", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`board fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  // The room work-claims route may return { claims: [...] } or a bare array.
  return Array.isArray(data) ? { claims: data } : data;
}

// --- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    boardFixture: null,
    boardUrl: null,
    boardToken: process.env.BOARD_TOKEN ?? null,
    ciFixture: null,
    ciLog: null,
    cap: null,
    now: null,
    out: null,
    post: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--board-fixture") args.boardFixture = next();
    else if (a === "--board-url") args.boardUrl = next();
    else if (a === "--board-token") args.boardToken = next();
    else if (a === "--ci-fixture") args.ciFixture = next();
    else if (a === "--ci-log") args.ciLog = next();
    else if (a === "--cap") {
      const n = Number(next());
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("--cap must be a positive integer");
      args.cap = n;
    } else if (a === "--now") args.now = next();
    else if (a === "--out") args.out = next();
    else if (a === "--post") args.post = true;
    else if (a === "--help" || a === "-h") {
      console.log(`capacity-digest.mjs — FIX-55: board-capacity + CI queue-depth digest

  --board-fixture <path>   board JSON: { claims: [{ state }] } or { open: n }
  --board-url <url>        fetch board JSON (Bearer $BOARD_TOKEN if set)
  --ci-fixture <path>      one ci.queue_depth_sample JSON (FIX-22c shape)
  --ci-log <path>          JSONL samples log; uses the latest line
  --cap <n>                override the board open-claim cap (default 200)
  --now <iso>              digest timestamp (default: now)
  --out <path>             also write the digest payload JSON to a file
  --post                   POST the digest to $CAPACITY_DIGEST_WEBHOOK_URL
                           (opt-in only; without the env var this fails loudly)

Default: print the digest to stdout, no external writes.`);
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let boardInput = null;
  if (args.boardFixture) boardInput = readJsonFile(args.boardFixture);
  else if (args.boardUrl) boardInput = await fetchBoard(args.boardUrl, args.boardToken);
  if (args.cap !== null) boardInput = { ...(boardInput ?? {}), cap: args.cap };

  let ciInput = null;
  if (args.ciFixture) ciInput = readJsonFile(args.ciFixture);
  else if (args.ciLog) ciInput = readLastJsonlLine(args.ciLog);

  const digest = buildDigest({ board: boardInput, ciQueue: ciInput, now: args.now });
  console.log(digest.text);

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(digest, null, 2) + "\n");
  }

  if (args.post) {
    const url = process.env.CAPACITY_DIGEST_WEBHOOK_URL;
    if (!url) {
      console.error("error: --post needs CAPACITY_DIGEST_WEBHOOK_URL set; refusing to post nowhere");
      process.exit(2);
    }
    const res = await postDigest(digest, { url, token: process.env.CAPACITY_DIGEST_WEBHOOK_TOKEN });
    console.error(`posted digest: HTTP ${res.status}`);
    if (!res.ok) process.exit(3);
  }
}

const invokedAsCli = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedAsCli) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
