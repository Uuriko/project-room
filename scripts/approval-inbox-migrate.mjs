#!/usr/bin/env node
// scripts/approval-inbox-migrate.mjs
// WAVE-500 guild 10/10 slice 23/50: one-time tap-list -> approval-inbox migration.
//
// Reads the standing tap list (~/workspace/taps/TAPS-2026-09-22.md), parses it
// with sibling slice 8's parser (server/approval-inbox-import.mjs, PR #2588),
// and files one DRAFT card per pending tap through sibling slice 1's store
// seam (server/approval-inbox-store.mjs, PR #2579).
//
// Safety contract (the point of this slice):
// - dry-run is the default: parses and reports, touches nothing.
// - idempotent: a migration journal (sourceRef -> cardId, plus skipped retired)
//   makes re-runs no-ops; card ids are deterministic ("tap-migrate-<ref>").
// - reversible: drafts only, inert data; the tap file is never modified or
//   deleted. The journal's created map is the exact reversal list.
// - lazy seams, clear degradation: both sibling modules import lazily. Until
//   PR #2588 merges, a documented fallback parser (same seam contract) runs
//   and says so. Until PR #2579 merges, --apply refuses with a clear error
//   instead of half-writing.
//
// Usage:
//   node scripts/approval-inbox-migrate.mjs [--taps PATH] [--journal PATH]        # dry-run
//   node scripts/approval-inbox-migrate.mjs --apply --db PATH [--taps PATH] [--journal PATH]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export function parseArgs(argv) {
  const opts = {
    dryRun: true, apply: false, dbPath: null,
    tapsPath: join(homedir(), "workspace", "taps", "TAPS-2026-09-22.md"),
    journalPath: join(process.cwd(), "approval-inbox-migration.json"),
    storePath: null, parserPath: null, createStore: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") { opts.apply = true; opts.dryRun = false; }
    else if (a === "--dry-run") { opts.dryRun = true; opts.apply = false; }
    else if (a === "--db") opts.dbPath = argv[++i];
    else if (a === "--taps") opts.tapsPath = argv[++i];
    else if (a === "--journal") opts.journalPath = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`unknown flag ${a} (see --help)`);
  }
  if (opts.apply && !opts.dbPath) throw new Error("--apply requires --db <sqlite-path>");
  if (!opts.tapsPath) throw new Error("missing --taps path");
  return opts;
}

function printHelp() {
  console.log(`usage:
  node scripts/approval-inbox-migrate.mjs [--taps PATH] [--journal PATH]   dry-run (default)
  node scripts/approval-inbox-migrate.mjs --apply --db PATH [--taps PATH] [--journal PATH]

One-time migration: tap list -> DRAFT approval-inbox cards. Never modifies the
tap file. Re-runs are no-ops via the journal (default ./approval-inbox-migration.json).`);
}

// --- Slice-8 seam (PR #2588), documented fallback ---------------------------
// parseTapList(markdown) -> [{ kind, title, what, context, options, sourceRef }]
// Conventions: numbered `N.`/`Nb.` items under ## sections; RETIRED/RESOLVED/
// CLOSED/DONE or ~~struck~~ items and Parked/Closed-out/Standing sections never
// become drafts; sourceRef is `tap-<N>` for numbered items. The fallback below
// implements exactly this contract for numbered items (the live tap file has
// no "Added" bullet sections); it is replaced by the real parser once merged.
const HEADING = /^\s*#{1,3}\s+(.+?)\s*$/;
const NUMBERED = /^\s*(\d+[a-z]?)\.\s+(.+?)\s*$/;
const SKIP_SECTION = /closed out|parked|standing|batched for next device session/i;
const CLOSED_MARKER = /(^|[^A-Za-z])(RETIRED|RESOLVED|CLOSED|DONE)([^A-Za-z]|$)/;
const STRUCK = /~~/;
const SEPARATOR = /\s[—–-]\s|:\s/;
const PERMISSION_FIRST = /your call|owner action|owner-only|owner click|owner decision/i;
const KIND_RULES = [
  ["money", /\$\s?\d|\bUSDC\b|\bETH\b|\bSOL\b|\bmoney\b|prize|funding|payment|\bpay\b|paid|payout|budget|bounty|bounties|\bfee\b|\bcost\b|\bpool\b|treasury|spend|pricing|\btier\b|\bcredit\b/i],
  ["identity", /sign-in|signin|login|gmail|OAuth|\bPAT\b|token|credential|password|wallet|invite|identity|custod|session|secret|\bkey\b|keys|signature|forensics|2FA|MFA|\bauth\b/i],
  ["deploy", /\bdeploy|redeploy|release|\bship\b|production|\bmerge\b|merged|branch|\bCI\b|rollout|rollback|mainnet/i],
  ["permission", /owner action|owner-only|owner click|your call|your word|\btap\b|approve|approval|authoriz|decision|yes or no|yes\/no|ratif|permission/i],
  ["publish", /\bpublish|submission|submit|listing|\bpost\b|\bHN\b|outreach|press|announce/i],
];
const SECTION_KIND = [[/money|grants/i, "money"], [/credential|device session/i, "identity"], [/rsvp|decisions/i, "permission"]];

function classifyKind(text, section) {
  const t = String(text || "");
  if (PERMISSION_FIRST.test(t)) return "permission";
  for (const [kind, re] of KIND_RULES) if (re.test(t)) return kind;
  for (const [re, kind] of SECTION_KIND) if (re.test(section)) return kind;
  return "other";
}

function splitTitle(text) {
  const rest = String(text || "").trim();
  const bold = rest.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
  if (bold) return { title: bold[1].trim().replace(/[:–-]\s*$/, "").trim(), what: bold[2].trim() };
  const sep = rest.match(SEPARATOR);
  if (sep) return { title: rest.slice(0, sep.index).trim(), what: rest.slice(sep.index + sep[0].length).trim() };
  const sentence = rest.match(/^(.{10,120}?[.?!])\s+(.*)$/s);
  if (sentence) return { title: sentence[1].trim(), what: sentence[2].trim() };
  return { title: rest.slice(0, 140), what: "" };
}

export function fallbackParseTapList(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const drafts = [];
  let section = "";
  let skip = false;
  for (const line of markdown.split("\n")) {
    const h = line.match(HEADING);
    if (h) { section = h[1].trim(); skip = SKIP_SECTION.test(section); continue; }
    if (skip || !line.trim()) continue;
    const m = line.match(NUMBERED);
    if (!m) continue;
    const raw = m[2].trim();
    if (STRUCK.test(raw) || CLOSED_MARKER.test(raw)) continue;
    const { title, what } = splitTitle(raw);
    drafts.push({
      kind: classifyKind(`${title} ${what}`, section),
      title: title.slice(0, 140),
      what: what.slice(0, 280),
      context: section.slice(0, 280),
      options: /yes or no|yes\/no/i.test(what) ? ["yes", "no"] : [],
      sourceRef: `tap-${m[1]}`,
    });
  }
  return drafts;
}

async function resolveParser({ parserPath }) {
  const href = parserPath ?? new URL("../server/approval-inbox-import.mjs", import.meta.url).href;
  try {
    const mod = await import(href);
    if (typeof mod.parseTapList === "function") return { parseTapList: mod.parseTapList, source: "slice-8" };
  } catch { /* fall through to the documented fallback */ }
  console.error("note: slice-8 parser (PR #2588) not merged yet; using documented fallback parser");
  return { parseTapList: fallbackParseTapList, source: "fallback" };
}

// Retired/skip-section scan for the journal: same item walk as the parser so
// occurrence keys (`tap-31`, `tap-31#2`) line up with the drafts above.
function dedupeKey(base, seen) {
  seen[base] = (seen[base] ?? 0) + 1;
  return seen[base] === 1 ? base : `${base}#${seen[base]}`;
}

export function scanRetiredTaps(markdown) {
  const skipped = {};
  const seen = {};
  let skip = false;
  for (const line of String(markdown || "").split("\n")) {
    const h = line.match(HEADING);
    if (h) { skip = SKIP_SECTION.test(h[1]); continue; }
    const m = line.match(NUMBERED);
    if (!m) continue;
    const key = dedupeKey(`tap-${m[1]}`, seen);
    const raw = m[2].trim();
    if (skip) skipped[key] = "skip-section";
    else if (STRUCK.test(raw) || CLOSED_MARKER.test(raw)) skipped[key] = "retired";
  }
  return skipped;
}

// --- Slice-1 seam (PR #2579), lazy ------------------------------------------
// ApprovalInboxStore: createCard({id,kind,title,what,context,options,requestedBy})
// throws ApprovalInboxError code "duplicate_card" on id collision;
// getCard(id) -> card|null. Until the PR merges, --apply degrades clearly.
async function resolveStoreOpener({ storePath, createStore }) {
  if (typeof createStore === "function") return { open: createStore, source: "injected" };
  const href = storePath ?? new URL("../server/approval-inbox-store.mjs", import.meta.url).href;
  try {
    const mod = await import(href);
    if (!mod.ApprovalInboxStore) throw new Error("module has no ApprovalInboxStore export");
    return { open: dbPath => new mod.ApprovalInboxStore({ db: new DatabaseSync(dbPath) }), source: "slice-1" };
  } catch (error) {
    const err = new Error(
      `approval-inbox store seam unavailable: slice 1 (PR #2579, server/approval-inbox-store.mjs) ` +
      `is not merged yet — --apply cannot run safely; dry-run still works`);
    err.cause = error;
    throw err;
  }
}

const idFor = (key, used) => {
  const base = `tap-migrate-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 120);
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
};

function loadJournal(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    j.created ??= {};
    j.skipped ??= {};
    return j;
  } catch {
    return { version: 1, created: {}, skipped: {} };
  }
}

export async function runMigration(opts) {
  const markdown = readFileSync(opts.tapsPath, "utf8");
  const { parseTapList, source: parserSource } = await resolveParser(opts);
  const retired = scanRetiredTaps(markdown);
  const seen = {};
  const items = parseTapList(markdown).map(draft => ({ draft, key: dedupeKey(draft.sourceRef, seen) }));
  const journal = loadJournal(opts.journalPath);
  journal.tapsFile ??= opts.tapsPath;

  let store = null;
  let storeSource = "none";
  if (opts.apply) {
    const opener = await resolveStoreOpener(opts); // throws a clear error when the seam is missing
    store = opener.open(opts.dbPath);
    storeSource = opener.source;
  }

  const usedIds = new Set(Object.values(journal.created));
  let draftsCreated = 0;
  let alreadyPresent = 0;
  let planned = 0;
  for (const { draft, key } of items) {
    const cardId = journal.created[key] ?? idFor(key, usedIds);
    if (journal.created[key]) {
      const existing = store ? store.getCard(cardId) : { id: cardId };
      if (existing) { alreadyPresent++; continue; }
      // journal entry but card gone (db rebuilt): recreate below
    } else if (store && store.getCard(cardId)) {
      alreadyPresent++;
      journal.created[key] = cardId; // backfill: card predates the journal
      continue;
    }
    if (!opts.apply) { planned++; continue; }
    try {
      const card = store.createCard({
        id: cardId,
        kind: draft.kind,
        title: `[DRAFT] ${draft.title}`.slice(0, 200),
        what: draft.what || draft.title,
        context: { note: `Tap-list migration draft (${key}); section: ${draft.context}. Source: ${opts.tapsPath}. Inert until a human confirms — not a live card.` },
        options: (draft.options ?? []).map(label => ({ label: String(label).slice(0, 200), consequence: "" })),
        requestedBy: "tap-list-migration",
      });
      journal.created[key] = card.id;
      draftsCreated++;
    } catch (error) {
      if (error?.code === "duplicate_card") { alreadyPresent++; journal.created[key] = cardId; continue; }
      throw error;
    }
  }

  const skippedRetired = Object.values(retired).filter(r => r === "retired").length;
  if (opts.apply) {
    journal.skipped = { ...retired, ...journal.skipped }; // existing entries win
    journal.at = new Date().toISOString();
    writeFileSync(opts.journalPath, JSON.stringify(journal, null, 2) + "\n");
  }
  const summary = { draftsCreated, skippedRetired, alreadyPresent, planned, parserSource, storeSource, store };
  const mode = opts.apply ? "applied" : "dry-run";
  console.log(`approval-inbox migration (${mode}; parser=${parserSource}, store=${storeSource}): ` +
    `${draftsCreated} drafts created, ${skippedRetired} skipped (retired), ${alreadyPresent} already present` +
    (opts.apply ? "" : `, ${planned} planned`));
  return summary;
}

async function main() {
  const summary = await runMigration(parseArgs(process.argv.slice(2)));
  if (summary.store && typeof summary.store.close === "function") summary.store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`migration failed: ${error.message}`); process.exit(1); });
}
