#!/usr/bin/env node
// scripts/approval-inbox-seed.mjs - seed the unified approval inbox from the tap list.
// WAVE-500 guild 10 slice 21/50.
//
//   node scripts/approval-inbox-seed.mjs --tap-file <md> [--dry-run] [--db <path>] [--confirm]
//
// Default is --dry-run: prints the card drafts it WOULD create
// (kind/title/sourceRef), creates nothing. With --db <path> --confirm it
// writes drafts to the inbox store as pending cards. Card ids are
// deterministic ("seed-<sourceRef>"), so re-running skips present cards.
//
// SEAMS (sibling guild-10 slices, both lazy-loaded):
// - Parser (slice 8): server/approval-inbox-import.mjs exporting
//   parseTapList(markdown) -> [{context,kind,options,sourceRef,title,what}].
//   Absent -> vendored minimal parser below (same draft contract), noted on
//   stderr; removed once slice 8 lands.
// - Store (slice 1): server/approval-inbox-store.mjs exporting
//   ApprovalInboxStore ({db} ctor, createCard(), getCard(id)). Absent ->
//   clear error, never a silent skip.
// Test hooks: APPROVAL_INBOX_IMPORT_PATH / APPROVAL_INBOX_STORE_PATH.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPORT_PATH = process.env.APPROVAL_INBOX_IMPORT_PATH
  || join(HERE, "..", "server", "approval-inbox-import.mjs");
const STORE_PATH = process.env.APPROVAL_INBOX_STORE_PATH
  || join(HERE, "..", "server", "approval-inbox-store.mjs");

const DRAFT_KINDS = Object.freeze(["money", "identity", "deploy", "permission", "publish", "other"]);
const REQUESTED_BY = "tap-list-seed";

// --- Vendored minimal tap-list parser (slice-8 fallback) -------------------
// Contract mirror of server/approval-inbox-import.mjs per slice 8's test:
//   parseTapList(markdown) -> [{context, kind, options, sourceRef, title, what}]
// Numbered entries ("1.", "11b.") become tap-<n>; bullets under an
// "## Added <date>" section become added-<date>-<k>. Entries mentioning
// RETIRED or wrapped in ~~strikethrough~~ are skipped, as are whole Parked /
// Closed-out sections. "(a) ... (b) ..." lettered options are extracted.
// sourceRef collisions get a numeric suffix so ids stay unique.
const KIND_RULES = [
  ["money", /\$|\bpool\b|\bUSDC\b|\bETH\b|\bSOL\b|\bBTC\b|\bprize|\bpayout|\bbounty|\bfunding\b|\bwallet\b|\bbilling\b|\bpast due\b/i],
  ["identity", /\boauth\b|\bgrant\b|\btoken\b|\bcredential|\bsign-in\b|\blogin\b|\bmfa\b|\bpasskey\b|\bcustod|\bsecret\b|\brevoke\b|\bkey\b/i],
  ["deploy", /\bdeploy|\bredeploy|\brelease\b|\brollout\b|\bproduction\b/i],
  ["publish", /\bpublish|\blisting\b|\bsubmission\b|\bdirectory\b|\bshow hn\b/i],
  ["permission", /\byour call\b|\bowner\b|\bapprove|\bdecision\b|\byes or no\b|\bratifi|\bgo\/no-go\b/i],
];
const HINT_RULES = [
  ["money", /\bmoney\b|\bfinance\b/i],
  ["identity", /\bsecur|\bidentity\b|\bcredential|\baccess\b/i],
  ["deploy", /\bdeploy|\binfra\b/i],
  ["publish", /\bpublish|\blisting\b|\bdirector/i],
  ["permission", /\bdecisions?\b/i],
];
function vendorClassifyTapKind(title, sectionHint = "") {
  for (const [kind, re] of KIND_RULES) if (re.test(String(title))) return kind;
  for (const [kind, re] of HINT_RULES) if (re.test(String(sectionHint))) return kind;
  return "other";
}

function vendorEmitDraft(drafts, usedRefs, entry, section) {
  const raw = entry.text.trim();
  if (!raw) return;
  const plain = raw.replace(/\*\*/g, "");
  if (/RETIRED/.test(plain) || /~~[^~]*~~/.test(plain)) return;
  let title, what;
  const boldTitle = raw.match(/^\*\*([^*]+)\*\*\s*([\s\S]*)$/);
  if (boldTitle) {
    // A leading bold span is the tap list's own title marker.
    title = boldTitle[1].trim();
    what = boldTitle[2].replace(/\*\*/g, "").trim();
  } else {
    const text = plain;
    // Title/body separator is the em dash (escape, never a literal em dash
    // in source); when there is none, the first sentence becomes the title;
    // final fallback is " - " for plain-ASCII fixtures.
    let dashAt = text.indexOf("\u2014");
    let sepLen = 1;
    let keepPunct = false;
    if (dashAt === -1) {
      const sent = text.search(/[.!?]\s/);
      if (sent !== -1) { dashAt = sent; sepLen = 2; keepPunct = true; }
      else { dashAt = text.indexOf(" - "); sepLen = 3; }
    }
    title = (dashAt === -1 ? text : text.slice(0, dashAt + (keepPunct ? 1 : 0))).trim();
    what = (dashAt === -1 ? "" : text.slice(dashAt + sepLen)).trim();
  }
  if (!title) return;
  const options = [];
  const optRe = /\(([a-z])\)\s*([^()]*?)(?=\s*\([a-z]\)\s*|$)/g;
  let m;
  while ((m = optRe.exec(what)) !== null) if (m[2].trim()) options.push(m[2].trim());
  let ref = entry.ref;
  let n = 2;
  while (usedRefs.has(ref)) ref = `${entry.ref}-${n++}`;
  usedRefs.add(ref);
  drafts.push({ context: section, kind: vendorClassifyTapKind(`${title} ${what}`, section), options, sourceRef: ref, title, what });
}

function vendorParseTapList(markdown) {
  const drafts = [];
  const usedRefs = new Set();
  let section = "", sectionDate = null, skipSection = false, addedIdx = 0, current = null;
  const flush = () => {
    if (current) { vendorEmitDraft(drafts, usedRefs, current, section); current = null; }
  };
  for (const rawLine of String(markdown).split("\n")) {
    const line = rawLine.trim();
    const header = line.match(/^##\s+(.*)$/);
    if (header) {
      flush();
      section = header[1].trim();
      skipSection = /parked|closed out/i.test(section);
      const dm = section.match(/(\d{4}-\d{2}-\d{2})/);
      sectionDate = dm ? dm[1] : null;
      addedIdx = 0;
      continue;
    }
    if (skipSection || line === "" || /^\*\*[^*]+\*\*:?\s*$/.test(line)) { flush(); continue; }
    const numbered = line.match(/^(\d+[a-z]?)\.\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (numbered) {
      flush();
      current = { ref: `tap-${numbered[1]}`, text: numbered[2] };
    } else if (bullet && /^added\b/i.test(section) && sectionDate) {
      flush();
      addedIdx += 1;
      current = { ref: `added-${sectionDate}-${addedIdx}`, text: bullet[1] };
    } else if (current) {
      current.text += ` ${line}`;
    }
  }
  flush();
  return drafts;
}
// --- end vendored parser ---------------------------------------------------

const USAGE_TEXT = `usage: node scripts/approval-inbox-seed.mjs --tap-file <md> [--dry-run] [--db <path>] [--confirm]

Seed the unified approval inbox from a tap-list markdown file.

  --tap-file <md>   tap list to seed from (required)
  --dry-run         print the card drafts it WOULD create; create nothing (default)
  --db <path>       inbox sqlite db; enables presence checks, writes with --confirm
  --confirm         write drafts to the store (requires --db); skips cards already present

Card ids are deterministic ("seed-<sourceRef>"), so re-running never duplicates.`;

function usage() {
  console.error(USAGE_TEXT);
}

function usageError(message) {
  const err = new Error(message);
  err.code = "usage";
  return err;
}

function parseArgs(argv) {
  const args = { tapFile: null, db: null, confirm: false, help: false, dryRunFlag: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--tap-file" || a.startsWith("--tap-file=")) {
      args.tapFile = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
    } else if (a === "--dry-run") args.dryRunFlag = true;
    else if (a === "--db" || a.startsWith("--db=")) {
      args.db = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
    } else if (a === "--confirm") args.confirm = true;
    else throw usageError(`unknown argument: ${a}`);
  }
  if (!args.tapFile && !args.help) throw usageError("--tap-file <md> is required");
  if (args.confirm && !args.db) throw usageError("--confirm requires --db <path>");
  if (args.confirm && args.dryRunFlag) throw usageError("cannot combine --dry-run and --confirm");
  return args;
}

async function loadParser() {
  try {
    const mod = await import(pathToFileURL(IMPORT_PATH).href);
    if (typeof mod.parseTapList !== "function") throw new Error("no parseTapList export");
    return { parseTapList: mod.parseTapList, kinds: mod.DRAFT_KINDS ?? DRAFT_KINDS, vendored: false };
  } catch {
    return { parseTapList: vendorParseTapList, kinds: DRAFT_KINDS, vendored: true };
  }
}

async function loadStore() {
  try {
    const mod = await import(pathToFileURL(STORE_PATH).href);
    if (typeof mod.ApprovalInboxStore !== "function") throw new Error("no ApprovalInboxStore export");
    return mod.ApprovalInboxStore;
  } catch {
    return null;
  }
}

function toCard(draft, tapBase, kinds) {
  const kind = kinds.includes(draft.kind) ? draft.kind : "other";
  const options = (draft.options ?? []).map((o) => (typeof o === "string"
    ? { label: o.slice(0, 200), consequence: "" }
    : { label: String(o.label ?? "").slice(0, 200), consequence: String(o.consequence ?? "").slice(0, 2000) }));
  const sectionNote = typeof draft.context === "string" && draft.context ? ` section: ${draft.context}` : "";
  return {
    sourceRef: draft.sourceRef,
    id: `seed-${draft.sourceRef}`,
    kind,
    title: String(draft.title).slice(0, 200),
    what: String(draft.what || draft.title).slice(0, 4000),
    context: `Seeded from tap list ${tapBase}; sourceRef=${draft.sourceRef}.${sectionNote}`.slice(0, 4000),
    options,
    requestedBy: REQUESTED_BY,
  };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err.code === "usage") { console.error(`error: ${err.message}`); usage(); return 2; }
    throw err;
  }
  if (args.help) { console.log(USAGE_TEXT); return 0; }

  let markdown;
  try {
    markdown = readFileSync(args.tapFile, "utf8");
  } catch (err) {
    console.error(`error: cannot read tap file ${args.tapFile}: ${err.message}`);
    return 1;
  }

  const parser = await loadParser();
  if (parser.vendored) console.error("note: using vendored tap-list parser (slice-8 server/approval-inbox-import.mjs not found)");
  const cards = parser.parseTapList(markdown).map((d) => toCard(d, basename(args.tapFile), parser.kinds));

  let store = null;
  if (args.db && (existsSync(args.db) || args.confirm)) {
    const StoreClass = await loadStore();
    if (!StoreClass) {
      console.error(`error: approval-inbox store module not available at ${STORE_PATH}; cannot use --db`);
      return 1;
    }
    const { DatabaseSync } = await import("node:sqlite");
    store = new StoreClass({ db: new DatabaseSync(args.db, args.confirm ? {} : { readOnly: true }) });
  }

  let skipped = 0, created = 0, failed = 0;
  for (const card of cards) {
    let present = false;
    if (store) {
      try {
        const found = store.getCard(card.id);
        present = found !== null && found !== undefined;
      } catch (err) {
        console.error(`error: getCard failed for ${card.id}: ${err.message}`);
        return 1;
      }
    }
    if (present) {
      skipped += 1;
      console.log(`[skip-present] kind=${card.kind} sourceRef=${card.sourceRef} title=${card.title}`);
      continue;
    }
    if (!args.confirm) {
      console.log(`[would-create] kind=${card.kind} sourceRef=${card.sourceRef} title=${card.title}`);
      continue;
    }
    try {
      const { sourceRef: _ignored, ...payload } = card;
      store.createCard(payload);
      created += 1;
      console.log(`[created] kind=${card.kind} sourceRef=${card.sourceRef} title=${card.title}`);
    } catch (err) {
      failed += 1;
      console.error(`error: createCard failed for ${card.id}: ${err.message}`);
    }
  }

  console.log(args.confirm
    ? `seed summary: drafts=${cards.length} skipped=${skipped} created=${created} failed=${failed}`
    : `seed summary: drafts=${cards.length} skipped=${skipped} would-create=${cards.length - skipped}`);
  return failed > 0 ? 1 : 0;
}

const code = await main(process.argv.slice(2)).catch((err) => {
  console.error(`error: ${err.message}`);
  return 1;
});
process.exit(code ?? 0);
