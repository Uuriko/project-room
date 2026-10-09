#!/usr/bin/env node
// scripts/pre-pr-board-scan.mjs
//
// Machine half of the "search board for my files" pre-PR checklist
// (claim-first norm): scans the live work-claims board for OTHER active
// claims whose `files` overlap yours, so convergent work is caught
// BEFORE a PR goes up instead of during review.
//
// Usage:
//   node scripts/pre-pr-board-scan.mjs --claim <id> | --files a.js,b.js
//     [--board <fixture.json>] [--room <name>] [--url <board-url>]
//     [--quiet] [--json]
//
//   --claim <id>   your claim id; excluded from collision results
//   --files        comma-separated repo-relative paths you are about to PR
//   --board        fixture JSON instead of the live board (offline/tests)
//   --room         room slug (default: muse-room)
//   --url          override the board endpoint URL
//   --json         print the overlap report as JSON on stdout
//   --quiet        print only the report, no hints
//
// Board payload shape (live or fixture): { "claims": [ ... ] } or a bare
// array. Each claim: { "id", "title", "state", "files": [...] }. Any
// additional fields are ignored.
//
// Exit codes:
//   0  clean — no other active claim touches your files
//   1  overlap found — prints "possible convergent work — coordinate before PR"
//   2  usage error
//   3  board unreachable / unreadable — cannot verify; investigate, don't PR blind
//
// Backward-compatible by construction: read-only against the board
// (HTTP GET only), additive file, no changes to existing behavior.

import { readFileSync } from "node:fs";

// States that count as "active" for collision purposes. Matched
// case-insensitively; unknown states are treated as active on purpose —
// better to surface a claim you can eyeball than to silently miss one.
const ACTIVE_STATES = new Set([
  "claimed", "in_progress", "working", "open", "submitted", "active",
  "pending", "leased", "running",
]);
const INACTIVE_STATES = new Set([
  "completed", "cancelled", "failed", "expired", "released", "done",
  "rejected", "superseded",
]);

function isActive(claim) {
  const s = String(claim.state ?? "").toLowerCase();
  if (INACTIVE_STATES.has(s)) return false;
  if (ACTIVE_STATES.has(s)) return true;
  return true; // unknown state: err on the visible side
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claim") out.claim = argv[++i];
    else if (a === "--files") out.files = argv[++i];
    else if (a === "--board") out.board = argv[++i];
    else if (a === "--room") out.room = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

async function fetchBoard({ board, url, room }) {
  if (board) {
    let raw;
    try {
      raw = readFileSync(board, "utf8");
    } catch (e) {
      throw new Error(`cannot read fixture board file ${board}: ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`fixture board file ${board} is not valid JSON: ${e.message}`);
    }
    return parsed;
  }
  const endpoint = url || `https://room.trydemigod.com/api/rooms/${room || "muse-room"}/work-claims?limit=200`;
  let res;
  try {
    res = await fetch(endpoint, { headers: { "User-Agent": "project-room/pre-pr-board-scan" } });
  } catch (e) {
    throw new Error(`board unreachable at ${endpoint}: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`board returned HTTP ${res.status} at ${endpoint}`);
  }
  return res.json();
}

function normalizeClaims(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.claims)) return payload.claims;
  if (payload && Array.isArray(payload.items)) return payload.items;
  throw new Error("board payload is not a claims array and has no .claims/.items array");
}

function normFile(p) {
  return String(p).replace(/^\.\//, "").replace(/\\/g, "/");
}

function scan(claims, myFiles, myClaim) {
  const mine = new Set(myFiles.map(normFile));
  const collisions = [];
  const unscannable = [];
  for (const c of claims) {
    if (!c || typeof c !== "object") continue;
    if (myClaim && String(c.id ?? "") === String(myClaim)) continue; // own claim: never collides with itself
    if (!isActive(c)) continue;
    const files = Array.isArray(c.files) ? c.files.map(normFile) : null;
    if (!files || files.length === 0) {
      // FIX-45 may enforce/default `files` on claims; until then, a claim
      // without files can't be scanned — warn, don't treat as clean.
      unscannable.push({ id: String(c.id ?? "(no id)"), title: String(c.title ?? "") });
      continue;
    }
    const overlap = files.filter((f) => mine.has(f));
    if (overlap.length > 0) {
      collisions.push({
        id: String(c.id ?? "(no id)"),
        title: String(c.title ?? ""),
        state: String(c.state ?? ""),
        overlappingFiles: overlap,
      });
    }
  }
  return { collisions, unscannable };
}

function printHuman({ collisions, unscannable }, { quiet, json, myClaim, myFiles }) {
  if (json) {
    const report = {
      ok: collisions.length === 0,
      myClaim: myClaim || null,
      myFiles,
      collisions,
      unscannableClaims: unscannable,
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (collisions.length > 0) {
    console.log("possible convergent work — coordinate before PR:");
    for (const c of collisions) {
      const who = c.title ? `${c.id} ("${c.title}")` : c.id;
      console.log(`  - ${who} [${c.state}] touches: ${c.overlappingFiles.join(", ")}`);
    }
    if (!quiet) {
      console.error("hint: compare branch diffs with the other claim owner before opening your PR.");
    }
  } else {
    console.log("board scan clean: no other active claim touches your files.");
  }
  for (const u of unscannable) {
    const who = u.title ? `${u.id} ("${u.title}")` : u.id;
    console.error(`warn: claim ${who} has no files listed — unscannable, coordinate manually if it might overlap.`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`usage: node scripts/pre-pr-board-scan.mjs --claim <id> | --files a.js,b.js [--board fixture.json] [--room <slug>] [--url <endpoint>] [--json] [--quiet]\nerror: ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log("usage: node scripts/pre-pr-board-scan.mjs --claim <id> | --files a.js,b.js [--board fixture.json] [--room <slug>] [--url <endpoint>] [--json] [--quiet]");
    process.exit(0);
  }
  const myFiles = opts.files
    ? opts.files.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (!opts.claim && myFiles.length === 0) {
    console.error("usage: pass --claim <id> (excluded from results) and/or --files a.js,b.js\nerror: nothing to scan — no files and no claim given");
    process.exit(2);
  }
  // If only --claim was given, try to resolve its files from the board payload.
  let board;
  try {
    board = await fetchBoard(opts);
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error("cannot verify the board — do not PR blind. Investigate board access first.");
    process.exit(3);
  }
  let claims;
  try {
    claims = normalizeClaims(board);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  let effectiveFiles = myFiles;
  if (effectiveFiles.length === 0 && opts.claim) {
    const me = claims.find((c) => c && String(c.id) === String(opts.claim));
    const claimed = me && Array.isArray(me.files) ? me.files.filter(Boolean) : [];
    if (claimed.length === 0) {
      console.error(`error: claim ${opts.claim} lists no files on the board and --files was not given`);
      process.exit(2);
    }
    effectiveFiles = claimed.map(String);
  }
  const { collisions, unscannable } = scan(claims, effectiveFiles, opts.claim);
  printHuman({ collisions, unscannable }, { quiet: opts.quiet, json: opts.json, myClaim: opts.claim, myFiles: effectiveFiles });
  process.exit(collisions.length > 0 ? 1 : 0);
}

main();
