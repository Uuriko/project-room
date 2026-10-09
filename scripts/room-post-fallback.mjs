#!/usr/bin/env node
// scripts/room-post-fallback.mjs
//
// FIX-74 — Degraded-mode room-post fallback grammar.
//
// When the work-claim board is unusable (pinned at cap, API down), agents can
// coordinate through room posts using a strict one-line-per-intent grammar.
// This script parses room event-log messages into intent records and applies
// server-seq-ordered first-post-wins arbitration.
//
// DEGRADED MODE ONLY. This is NEVER the registry. The board stays the source
// of truth; when the board recovers, reconcile every fallback decision
// against it (see docs/ROOM-POST-FALLBACK-RUNBOOK.md).
//
// Grammar (one intent per line; fields in alphabetical order):
//   BOUNTY <id> | by=<agent> | reward=<amount> | title=<text>
//   TAKE <bounty-id> | by=<agent>
//   HB <agent> | seq=<n>
//   RELEASE <bounty-id> | by=<agent>
//   DONE <bounty-id> | by=<agent> | proof=<text>
//
// Arbitration: same intent (VERB:subject) from two agents -> the EARLIER
// server sequence number wins. Ties on seq are broken deterministically by
// sender id (lexicographically ascending, code-unit order). Client
// wall-clock (`at`) is NEVER consulted.
//
// This is a standalone offline tool. It is not wired into any live server
// path.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// ---------------------------------------------------------------- grammar

const VERBS = {
  BOUNTY: ["by", "reward", "title"],
  TAKE: ["by"],
  HB: ["seq"],
  RELEASE: ["by"],
  DONE: ["by", "proof"],
};

const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// key=val where val starts and ends with a non-space char and contains no '|'.
const FIELD_RE = /^([a-z][a-z0-9_]*)=(\S(?:[^|]*\S)?)$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

/**
 * Parse one line into an intent record.
 * Returns:
 *   { ok: true, intent: { verb, subject, fields, raw } }
 *   { ok: false, ignored: true,  error }  -- blank / comment / plain chat
 *   { ok: false, ignored: false, error }  -- malformed grammar line
 */
export function parseLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (line === "" || line.startsWith("#")) {
    return { ok: false, ignored: true, error: "blank line or comment" };
  }
  const head = line.match(/^([A-Za-z]+)([\s\S]*)$/);
  if (!head) return { ok: false, ignored: true, error: "not a grammar line" };
  const [, word, rest] = head;
  const isCaps = /^[A-Z]+$/.test(word);
  // Lines that do not even attempt the grammar are plain chat: ignore them.
  if (!isCaps && !VERBS[word.toUpperCase()]) {
    return { ok: false, ignored: true, error: "not a grammar line" };
  }
  if (!isCaps) {
    return { ok: false, ignored: false, error: `verb must be uppercase, got ${JSON.stringify(word)}` };
  }
  const verb = word;
  const spec = VERBS[verb];
  if (!spec) {
    return { ok: false, ignored: false, error: `unknown verb ${JSON.stringify(verb)}` };
  }
  const subj = rest.match(/^ ([^ ]+)([\s\S]*)$/);
  if (!subj) {
    return { ok: false, ignored: false, error: `verb ${verb} is missing its subject` };
  }
  const [, subject, tail] = subj;
  if (!SUBJECT_RE.test(subject)) {
    return { ok: false, ignored: false, error: `invalid subject ${JSON.stringify(subject)}` };
  }
  const fields = {};
  if (tail !== "") {
    if (!tail.startsWith(" | ")) {
      return { ok: false, ignored: false, error: "fields must be separated from the subject by ' | '" };
    }
    for (const seg of tail.slice(3).split(" | ")) {
      const m = seg.match(FIELD_RE);
      if (!m) {
        return { ok: false, ignored: false, error: `bad field segment ${JSON.stringify(seg)}` };
      }
      const [, k, v] = m;
      if (k in fields) {
        return { ok: false, ignored: false, error: `duplicate field ${JSON.stringify(k)}` };
      }
      fields[k] = v;
    }
  }
  const keys = Object.keys(fields);
  const sorted = [...keys].sort();
  if (keys.join(",") !== sorted.join(",")) {
    return { ok: false, ignored: false, error: `fields must be in alphabetical order, got ${keys.join(", ")}` };
  }
  const want = [...spec].sort();
  if (keys.join(",") !== want.join(",")) {
    return {
      ok: false,
      ignored: false,
      error: `verb ${verb} requires exactly the fields ${spec.join(", ")}, got ${keys.join(", ") || "(none)"}`,
    };
  }
  if (verb === "HB" && !POSITIVE_INT_RE.test(fields.seq)) {
    return { ok: false, ignored: false, error: `HB seq must be a positive integer, got ${JSON.stringify(fields.seq)}` };
  }
  return { ok: true, intent: { verb, subject, fields, raw: rawLine } };
}

/**
 * Parse an event log (array of { seq, sender, body, at? }) into intent
 * records. `seq` is the ROOM SERVER's sequence number. Lines that are
 * blank, comments, or plain chat are ignored; grammar-looking lines that
 * fail strict parsing are collected as malformed.
 */
export function parseLog(events) {
  const records = [];
  const malformed = [];
  for (const e of events ?? []) {
    const seq = Number(e?.seq);
    const sender = String(e?.sender ?? "");
    if (!Number.isFinite(seq)) {
      malformed.push({
        seq: e?.seq ?? null,
        sender,
        line: String(e?.body ?? ""),
        error: "event is missing a numeric server seq",
      });
      continue;
    }
    for (const raw of String(e?.body ?? "").split("\n")) {
      const r = parseLine(raw);
      if (r.ok) {
        records.push({ ...r.intent, seq, sender, at: e?.at ?? null });
      } else if (!r.ignored) {
        malformed.push({ seq, sender, line: raw.trim(), error: r.error });
      }
    }
  }
  return { records, malformed };
}

// ---------------------------------------------------------------- arbitration

/** Intent identity: same verb + same subject = the same contestable intent. */
export function intentKey(intent) {
  return `${intent.verb}:${intent.subject}`;
}

function cmpSender(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Server-seq-ordered first-post-wins arbitration.
 * For each contested intent key, the record with the smallest server seq
 * wins; seq ties break deterministically by sender id (lexicographically
 * ascending, code-unit order). Client wall-clock is never consulted.
 * HB records are per-agent liveness markers (latest seq per agent) and are
 * never treated as conflicts.
 */
export function arbitrate(records) {
  const groups = new Map();
  const liveness = {};
  for (const r of records) {
    if (r.verb === "HB") {
      const cur = liveness[r.sender];
      if (!cur || r.seq > cur.seq) liveness[r.sender] = r;
      continue;
    }
    const key = intentKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const winners = {};
  const conflicts = [];
  for (const [key, rs] of groups) {
    const ordered = [...rs].sort((a, b) => a.seq - b.seq || cmpSender(a.sender, b.sender));
    winners[key] = ordered[0];
    if (ordered.length > 1) {
      conflicts.push({ key, winner: ordered[0], losers: ordered.slice(1) });
    }
  }
  return {
    winners,
    conflicts,
    liveness,
    counts: { records: records.length, contested: groups.size },
  };
}

// ---------------------------------------------------------------- CLI

function printHelp() {
  console.log(`room-post-fallback — degraded-mode room-post arbitration (FIX-74)

Usage:
  node scripts/room-post-fallback.mjs --log <events.json> [--format json|text]

<events.json> is a JSON array of room event-log entries:
  [{ "seq": 21, "sender": "dave", "body": "TAKE b-9 | by=dave", "at": "2026-10-09T10:00:00Z" }]

seq is the ROOM SERVER sequence number. Output ranks first-post-wins
winners per intent, flags seq ties resolved by sender id, and lists
malformed lines and per-agent liveness.

DEGRADED MODE ONLY — never the registry. Reconcile against the board when
it recovers. See docs/ROOM-POST-FALLBACK-RUNBOOK.md.`);
}

function parseArgs(argv) {
  const opts = { format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--log") opts.log = argv[++i];
    else if (a === "--format") opts.format = argv[++i];
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

function fmtRecord(r) {
  return `${r.sender} @ seq ${r.seq}`;
}

function printText(result, malformed) {
  const { winners, conflicts, liveness, counts } = result;
  console.log("# room-post-fallback (degraded mode)");
  console.log(`# ${counts.records} intent records, ${counts.contested} contested intents, ${conflicts.length} conflicts, ${malformed.length} malformed lines`);
  console.log("# WARNING: degraded mode only — never the registry. Reconcile against the board when it recovers.");
  console.log("\n## winners");
  const keys = Object.keys(winners).sort();
  if (!keys.length) console.log("(none)");
  for (const k of keys) console.log(`${k} -> ${fmtRecord(winners[k])}`);
  console.log("\n## conflicts");
  if (!conflicts.length) console.log("(none)");
  for (const c of [...conflicts].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    console.log(`${c.key}: winner ${fmtRecord(c.winner)}; losers: ${c.losers.map(fmtRecord).join(", ")}`);
  }
  console.log("\n## malformed lines");
  if (!malformed.length) console.log("(none)");
  for (const m of malformed) {
    console.log(`[seq ${m.seq}] ${m.sender}: ${JSON.stringify(m.line)} — ${m.error}`);
  }
  console.log("\n## liveness (latest HB per agent)");
  const agents = Object.keys(liveness).sort();
  if (!agents.length) console.log("(none)");
  for (const a of agents) console.log(`${a}: seq ${liveness[a].seq}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.log) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.format !== "json" && opts.format !== "text") {
    throw new Error(`--format must be json or text, got ${JSON.stringify(opts.format)}`);
  }
  let raw;
  try {
    raw = readFileSync(opts.log, "utf8");
  } catch (e) {
    throw new Error(`cannot read log file ${JSON.stringify(opts.log)}: ${e.message}`);
  }
  let events;
  try {
    events = JSON.parse(raw);
  } catch (e) {
    throw new Error(`log file is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(events)) {
    throw new Error("log file must contain a JSON array of event-log entries");
  }
  const { records, malformed } = parseLog(events);
  const result = arbitrate(records);
  if (opts.format === "json") {
    console.log(JSON.stringify({ ...result, malformed }, null, 2));
  } else {
    printText(result, malformed);
  }
}

const isMain = (() => {
  try {
    return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error(`room-post-fallback: ${e.message}`);
    process.exit(1);
  });
}
