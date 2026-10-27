#!/usr/bin/env node
// Regenerate skills/project-room/references/errors-catalog.md after server
// error changes. The catalog header has named this script since 2026-10-08;
// it did not exist — the catalog was produced once by a scratch generator
// and the drift guard's extractor quietly shared the same blind spots, so
// the catalog went stale behind a green test (63 verified wire codes
// missing at main 927a642029, clean-slate lane 24; a further 50 found by
// the widened extractor, job3 cure lane).
//
// This generator and the guard (tests/errors-catalog-drift.test.js) share
// ONE extractor (scripts/error-catalog-extraction.mjs):
//
//   node scripts/gen-error-catalog.mjs           # insert rows for extracted
//                                                # wire codes that have no row
//                                                # yet, recount the index
//                                                # headline, and report
//   node scripts/gen-error-catalog.mjs --check   # report only; exit 1 when a
//                                                # row is missing or a
//                                                # not-wire disposition rots
//   node scripts/gen-error-catalog.mjs --list    # print the extracted codes
//
// Inserted rows are stubs with an honest shape: HTTP status and meaning are
// taken from the first emit site the extractor can attribute (status slot
// next to the code, message slot after it); retry/recovery follow the live
// AX layer (src/agent-error.mjs) for that status+code, exactly as the
// catalog's own header describes its Recovery column. A stub whose status
// or message cannot be attributed is inserted at 500 with a "(generated
// stub — verify status and meaning against the emit site)" note; curate it
// in the same change. Existing rows are never rewritten.
//
// After running this, run `node scripts/skills-sync.mjs` so the plugins/
// mirror stays byte-identical, then `node --test
// tests/errors-catalog-drift.test.js`.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractLiveCodes, NOT_WIRE_CODES } from "./error-catalog-extraction.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "skills/project-room/references/errors-catalog.md");
const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const LIST = args.has("--list");

const codes = extractLiveCodes(ROOT);
if (LIST) {
  for (const c of [...codes].sort()) console.log(c);
  process.exit(0);
}

const md = readFileSync(CATALOG, "utf8");
const secStart = md.indexOf("## Full code index");
if (secStart < 0) { console.error("catalog is missing the '## Full code index' section"); process.exit(1); }
const section = md.slice(secStart);
const rowCodes = [...section.matchAll(/^\| `([a-z][a-z0-9_]*)` \|/gm)].map(m => m[1]);
const rows = new Set(rowCodes);

const missing = [...codes].filter(c => !rows.has(c) && !NOT_WIRE_CODES.has(c)).sort();
const staleDispositions = [...NOT_WIRE_CODES.keys()].filter(c => !codes.has(c) || rows.has(c));

// Best-effort emit-site evidence for a stub row: first server site where
// the code literal sits next to a numeric status and/or a message string
// in the same call (the shapes the extractor reads positionally).
import { readdirSync } from "node:fs";
function* walkMjs(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMjs(p);
    else if (e.name.endsWith(".mjs")) yield p;
  }
}
const serverTexts = [...walkMjs(join(ROOT, "server"))].map(f => readFileSync(f, "utf8"));
function evidence(code) {
  const lit = `["']${code}["']`;
  for (const t of serverTexts) {
    let m = new RegExp(`\\(\\s*(\\d{3})\\s*,\\s*${lit}\\s*,\\s*["']([^"']{3,120})["']`).exec(t);
    if (m) return { status: m[1], message: m[2] };
    m = new RegExp(`${lit}\\s*,\\s*["']([^"']{3,120})["']`).exec(t);
    if (m) return { status: null, message: m[1] };
    m = new RegExp(`\\(\\s*(\\d{3})\\s*,\\s*${lit}`).exec(t);
    if (m) return { status: m[1], message: null };
  }
  return { status: null, message: null };
}

function stubRow(code) {
  const ev = evidence(code);
  const status = ev.status ?? "500";
  const stub = ev.status === null || ev.message === null;
  const meaning = (ev.message ?? "Server-emitted error code (generated stub)").replaceAll("|", "\\|");
  const ax = agentErrorAx({ httpStatus: Number(status), code, message: meaning });
  let retry = "no";
  if (ax.hint.startsWith("Unknown error")) retry = "no";
  else if (/Retry-After/.test(ax.hint)) retry = "wait";
  else if (Number(status) === 404) retry = "re-list";
  else if (Number(status) === 400 || Number(status) === 422) retry = "fix+resend";
  const recovery = ax.hint.startsWith("Unknown error")
    ? "Re-check access and current work. If it repeats, report error.code and the full message to the room owner — this code has no mapped recovery."
    : ax.next.map(s => s.command ?? s.path ?? `tool:${s.tool}`).join(" ; ") || ax.hint;
  return `| \`${code}\` | ${status} | ${meaning}${stub ? " (generated stub — verify status and meaning against the emit site)" : ""} | ${retry} | ${recovery.replaceAll("|", "\\|")} |`;
}

let dirty = false;
let out = md;
if (missing.length && !CHECK) {
  const lines = out.split("\n");
  const start = lines.findIndex(l => l.startsWith("## Full code index"));
  for (const code of missing) {
    const ins = lines.findIndex((l, i) => {
      if (i < start) return false;
      const m = /^\| `([a-z][a-z0-9_]*)` \|/.exec(l);
      return m && m[1] > code;
    });
    if (ins < 0) { console.error(`no alphabetical insertion point for ${code}`); process.exit(1); }
    lines.splice(ins, 0, stubRow(code));
    console.log(`inserted stub row: ${code}`);
  }
  out = lines.join("\n");
  dirty = true;
}
// Recount the headline from the actual index (the headline itself has
// drifted before: it understated the index by 67 rows at main).
{
  const sec = out.slice(out.indexOf("## Full code index"));
  const all = [...sec.matchAll(/^\| `([a-z][a-z0-9_]*)` \|/gm)].map(m => m[1]);
  const headline = `${all.length} rows (${new Set(all).size} distinct codes).`;
  const next = out.replace(/^\d+ rows \(\d+ distinct codes\)\.$/m, headline);
  if (next !== out) { out = next; dirty = true; console.log(`headline recounted: ${headline}`); }
}
if (dirty && !CHECK) {
  writeFileSync(CATALOG, out);
  console.log("catalog updated; now run: node scripts/skills-sync.mjs");
}
for (const c of missing) console.log(`${CHECK ? "missing row" : "was missing"}: ${c}`);
for (const c of staleDispositions) console.log(`stale not-wire disposition (no longer extracted, or now rowed): ${c}`);
if (!missing.length && !staleDispositions.length) console.log("errors catalog is complete for the extracted wire codes; dispositions are live.");
if (CHECK && (missing.length || staleDispositions.length)) process.exit(1);
