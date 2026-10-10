#!/usr/bin/env node
// namespace-telemetry.mjs — FIX-58: per-namespace telemetry (rank 78).
//
// Emits one v:1 `gauge` record per claim namespace: live open count + top-5
// holders. The sibling surface is FIX-55's scripts/capacity-digest.mjs —
// same shape on purpose (pure builder, offline fixtures, stdout product,
// opt-in --post): this extends the board/capacity surface rather than
// inventing a parallel one.
//
// NAMESPACE (current model): namespaces are guild scopes. The repo has no
// `guild` field on claims; the guild-scope unit today is the top-level
// directory of a claim's file scopes on FIX-48's scope spine — `server/`
// and `server/http.mjs` both live in namespace `server` (see
// docs/telemetry/namespace-telemetry.md). Claims with no file scopes land in
// the `unscoped` bucket. A claim spanning several top-level directories
// counts as open in each of them.
//
// FIX-68 RE-HOMING: the claim-channel redesign is unbuilt. When it lands,
// this emitter's namespace derivation moves onto channel membership and the
// `caps` input becomes the channels' real caps; the gauge record shape
// (`type: "namespace.open_claims"`) does not change.
//
// Open = non-terminal claim states, the same set FIX-55 counts against the
// board cap (unclaimed, claimed, in_progress, blocked); done/closed are
// terminal. (FIX-48's LIVE_CLAIM_STATES excludes `unclaimed`; the difference
// is documented in the doc — unclaimed work is still open load in a
// namespace, and only owner-holding claims rank as holders.)
//
// Gauge mapping (kind "gauge", v:1 — see scripts/telemetry-schema.mjs):
//   type         "namespace.open_claims" (what this gauge measures)
//   repo         the room's repo (default Uuriko/project-room), overridable
//   interval_s   0 — point-in-time snapshot, not a windowed rate
//   queued       live open claims in the namespace
//   running      distinct holders with open claims in the namespace
//                (ownerless `unclaimed` claims count in queued, not here)
//   p50_wait_s   null — a namespace point sample carries no queue-wait
//                semantics; the wait authority stays FIX-22c's
//                `ci.queue_depth_sample` records
//   namespace    the namespace (extra payload field, additive per schema)
//   cap          per-namespace cap from the caps input, or null — the current
//                model has no per-namespace caps (only the global
//                maxOpenClaims and per-member maxMemberOpenClaims), so this
//                is the FIX-68 seam, not a live value
//   top_holders  up to 5 { holder, open }, ranked by open desc, ties broken
//                by holder name asc (deterministic)
//   timestamp    legacy alias of the envelope `ts` (gauge-kind convention)
//
// Usage:
//   node scripts/namespace-telemetry.mjs --board-fixture ./board.json
//   node scripts/namespace-telemetry.mjs --board-url https://room.trydemigod.com/api/rooms/muse-room/work-claims?limit=200
//   node scripts/namespace-telemetry.mjs --board-fixture ./board.json --caps ./caps.json --out telemetry/namespaces.jsonl
//   node scripts/namespace-telemetry.mjs --board-fixture ./board.json --post   # needs NAMESPACE_TELEMETRY_WEBHOOK_URL
//
// Board fixture/url shape: { claims: [{ id, owner, state, files }] } or a
// bare claims array. stdout is JSONL (one v:1 record per line) — the
// telemetry product; the human summary goes to stderr. --out writes the
// JSONL to a file. --post is opt-in only and never default-on.

import fs from "node:fs";
import path from "node:path";
import { envelope } from "./telemetry-schema.mjs";

// --- constants -------------------------------------------------------------

// Mirrors FIX-55's OPEN_CLAIM_STATES (scripts/capacity-digest.mjs): the states
// that count as open load. Kept in sync by tests/namespace-telemetry.test.js.
export const OPEN_CLAIM_STATES = Object.freeze(["unclaimed", "claimed", "in_progress", "blocked"]);
const TERMINAL_CLAIM_STATES = Object.freeze(["done", "closed"]);
const OPEN_STATES = new Set(OPEN_CLAIM_STATES);

export const UNSCOPED = "unscoped";
export const GAUGE_TYPE = "namespace.open_claims";
export const REPO_DEFAULT = "Uuriko/project-room";
export const TOP_HOLDERS_LIMIT = 5;

// --- namespace derivation ---------------------------------------------------

// Top-level directory of one file scope, e.g. "server/http.mjs" -> "server",
// "server/" -> "server". Returns null for anything that is not a usable path.
function namespaceOfScope(scope) {
  if (typeof scope !== "string") return null;
  let s = scope.trim().replace(/^\.\//, "");
  if (!s) return null;
  s = s.replace(/\/+$/, ""); // directory scopes ("server/") -> "server"
  if (!s || s === "." || s === ".." || s.includes("\0")) return null;
  const head = s.split("/")[0];
  if (!head || head === "." || head === "..") return null;
  return head;
}

// The namespaces a claim belongs to: one per top-level scope directory,
// deduplicated and sorted. Scopeless claims -> ["unscoped"]. A claim spanning
// several namespaces counts in each (open work is open work everywhere its
// scopes reach).
export function namespacesOf(claim) {
  const files = Array.isArray(claim?.files) ? claim.files : [];
  const seen = new Set();
  for (const f of files) {
    const ns = namespaceOfScope(f);
    if (ns) seen.add(ns);
  }
  if (seen.size === 0) return [UNSCOPED];
  return [...seen].sort();
}

// --- board normalization ----------------------------------------------------

function normalizeClaims(input) {
  const src = input ?? {};
  const claims = Array.isArray(src) ? src : src.claims;
  return Array.isArray(claims) ? claims : [];
}

function isOpen(claim) {
  if (!claim || typeof claim !== "object") return false;
  if (TERMINAL_CLAIM_STATES.includes(claim.state)) return false;
  return OPEN_STATES.has(claim.state);
}

function validCap(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// --- builder -----------------------------------------------------------------

// Pure computation: no I/O, no network. Returns
// { records, summary: { text, namespaces }, generatedAt }.
// `claims` may be a bare array or { claims }; `board` is the same shape
// (mirrors the capacity-digest fetch which returns either).
// `caps` is an optional { namespace: cap } map — the FIX-68 seam; the current
// model has no per-namespace caps, so unmapped namespaces report cap: null.
export function buildNamespaceTelemetry({ board, claims, caps, repo, now } = {}) {
  const list = normalizeClaims(claims ?? board);
  const capMap = caps && typeof caps === "object" ? caps : {};
  const repoName = typeof repo === "string" && repo ? repo : REPO_DEFAULT;
  const ts = now ? new Date(now).toISOString() : new Date().toISOString();
  const generatedAt = ts.replace(/\.\d{3}Z$/, "Z");

  // Aggregate open claims per namespace.
  const byNs = new Map(); // ns -> { open, holders: Map<holder, count> }
  for (const claim of list) {
    if (!isOpen(claim)) continue;
    const holder = typeof claim.owner === "string" && claim.owner ? claim.owner : null;
    for (const ns of namespacesOf(claim)) {
      let agg = byNs.get(ns);
      if (!agg) {
        agg = { open: 0, holders: new Map() };
        byNs.set(ns, agg);
      }
      agg.open += 1;
      if (holder) agg.holders.set(holder, (agg.holders.get(holder) ?? 0) + 1);
    }
  }

  const records = [];
  const summaryNs = {};
  const textLines = [`🛰️ namespace telemetry · ${generatedAt}`];
  for (const ns of [...byNs.keys()].sort()) {
    const agg = byNs.get(ns);
    const topHolders = [...agg.holders.entries()]
      .map(([holder, open]) => ({ holder, open }))
      .sort((a, b) => b.open - a.open || (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0))
      .slice(0, TOP_HOLDERS_LIMIT);
    const cap = validCap(capMap[ns]);
    records.push(
      envelope({
        kind: "gauge",
        ts,
        type: GAUGE_TYPE,
        repo: repoName,
        interval_s: 0,
        queued: agg.open,
        running: agg.holders.size,
        p50_wait_s: null,
        namespace: ns,
        cap,
        top_holders: topHolders,
        timestamp: ts,
      })
    );
    summaryNs[ns] = { open: agg.open, cap, holders: topHolders };
    const holderBits = topHolders.map((t) => `${t.holder}×${t.open}`).join(", ");
    textLines.push(
      `${ns}: ${agg.open} open${cap !== null ? ` (cap ${cap})` : ""}` +
        (holderBits ? ` · holders: ${holderBits}` : " · no holders")
    );
  }
  if (records.length === 0) textLines.push("(no open claims in any namespace)");

  return {
    records,
    summary: { text: textLines.join("\n"), namespaces: summaryNs },
    generatedAt,
  };
}

// --- posting transport (opt-in) -----------------------------------------------

// POSTs the records as JSONL to a webhook URL. The caller supplies the URL
// (normally via NAMESPACE_TELEMETRY_WEBHOOK_URL); fetchImpl is injectable so
// tests never touch the network. Throws on missing URL — never a silent misfire.
export async function postTelemetry(records, { url, token, fetchImpl } = {}) {
  if (!url) throw new Error("postTelemetry needs a webhook url (set NAMESPACE_TELEMETRY_WEBHOOK_URL or pass --post with the env configured)");
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("no fetch implementation available");
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  return { ok: !!res.ok, status: res.status };
}

// --- sources --------------------------------------------------------------------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fetchBoard(url, token) {
  const res = await globalThis.fetch(url, {
    headers: { "user-agent": "namespace-telemetry/1.0", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`board fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  // The room work-claims route may return { claims: [...] } or a bare array.
  return Array.isArray(data) ? { claims: data } : data;
}

// --- CLI --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    boardFixture: null,
    boardUrl: null,
    boardToken: process.env.BOARD_TOKEN ?? null,
    capsFile: null,
    repo: null,
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
    else if (a === "--caps") args.capsFile = next();
    else if (a === "--repo") args.repo = next();
    else if (a === "--now") args.now = next();
    else if (a === "--out") args.out = next();
    else if (a === "--post") args.post = true;
    else if (a === "--help" || a === "-h") {
      console.log(`namespace-telemetry.mjs — FIX-58: per-namespace live-open + top-5-holder gauges

  --board-fixture <path>   board JSON: { claims: [{ id, owner, state, files }] } or a bare array
  --board-url <url>        fetch board JSON (Bearer $BOARD_TOKEN if set)
  --caps <path>            JSON map { "<namespace>": <cap> } — the FIX-68 seam;
                           the current model has no per-namespace caps
  --repo <name>            repo stamped on the gauge records (default ${REPO_DEFAULT})
  --now <iso>              emission timestamp (default: now)
  --out <path>             write the JSONL records to a file
  --post                   POST the JSONL to $NAMESPACE_TELEMETRY_WEBHOOK_URL
                           (opt-in only; without the env var this fails loudly)

Default: print v:1 JSONL gauge records to stdout (one per namespace) and a
human summary to stderr. Nothing is sent anywhere without --post.`);
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

  let caps = null;
  if (args.capsFile) caps = readJsonFile(args.capsFile);

  const { records, summary } = buildNamespaceTelemetry({
    board: boardInput,
    caps,
    repo: args.repo,
    now: args.now,
  });

  for (const record of records) console.log(JSON.stringify(record));
  console.error(summary.text);

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  }

  if (args.post) {
    const url = process.env.NAMESPACE_TELEMETRY_WEBHOOK_URL;
    if (!url) {
      console.error("error: --post needs NAMESPACE_TELEMETRY_WEBHOOK_URL set; refusing to post nowhere");
      process.exit(2);
    }
    const res = await postTelemetry(records, { url, token: process.env.NAMESPACE_TELEMETRY_WEBHOOK_TOKEN });
    console.error(`posted namespace telemetry: HTTP ${res.status}`);
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
