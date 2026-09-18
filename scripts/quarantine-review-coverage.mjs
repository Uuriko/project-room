// Review-coverage dashboard for the spam-quarantine queue.
//
// Reads a room store READ-ONLY (PRAGMA query_only) and reports per-signal
// review coverage over the durable quarantine journal
// (server/spam-quarantine-journal.mjs): for each spam signal that fired on a
// held row, the held count, the reviewed count, the Confirm (released into
// the inbox) / Dismiss (confirmed spam) / Split (detached off its thread)
// breakdown, and the coverage ratio — the reviewCoverage metric from the
// #567 shadow-analysis tooling (server/quarantine-review-coverage.mjs).
//
// Usage:
//   node scripts/quarantine-review-coverage.mjs --store /path/to/room.db \
//     [--since 2026-09-18T00:00:00Z | --since <ms-epoch>] [--until ...] \
//     [--now <ms-epoch>] [--format text|json]
//
// --since/--until filter holds by their quarantined_at; a review verdict
//   joins regardless of when it landed. --now overrides "today" for
//   repeatable reports (default: Date.now()).
//
// Exit 0 with the dashboard on stdout. No writes, no network, no sends.
import { DatabaseSync } from "node:sqlite";
import { reviewCoverageBySignal } from "../server/quarantine-review-coverage.mjs";

const usage = `quarantine-review-coverage.mjs --store <room.db> [options]

Reads a room store read-only and reports per-signal review coverage over
the spam-quarantine journal.

Options:
  --store <path>            room store sqlite file (required)
  --since <date|epoch>      include holds quarantined at/after this time
  --until <date|epoch>      include holds quarantined before this time
  --now <epoch>             override "now" (default: current time)
  --format text|json        output format (default: text)
  --help                    this message`;

const args = process.argv.slice(2);
const get = name => {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
};
if (args.includes("--help")) { console.log(usage); process.exit(0); }

const storePath = get("--store");
if (!storePath) { console.error("error: --store <path> is required\n\n" + usage); process.exit(2); }
const format = get("--format") ?? "text";
if (!["text", "json"].includes(format)) { console.error("error: --format must be text or json"); process.exit(2); }

const parseTime = (raw, name) => {
  if (raw === null) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) { console.error(`error: ${name} "${raw}" is not a date or ms epoch`); process.exit(2); }
  return ms;
};
const since = parseTime(get("--since"), "--since");
const until = parseTime(get("--until"), "--until");
const now = parseTime(get("--now"), "--now") ?? Date.now();

let db;
try {
  db = new DatabaseSync(storePath, { readOnly: true });
} catch (error) {
  console.error(`error: cannot open store "${storePath}": ${error.message}`);
  process.exit(2);
}
db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000;");

const missingTable = error => error?.message?.includes("no such table");
let rows;
try {
  const where = ["1=1"];
  if (since !== null) where.push(`quarantined_at >= ${since}`);
  if (until !== null) where.push(`quarantined_at < ${until}`);
  rows = db.prepare(`
    SELECT id, status, quarantined_at AS quarantinedAt, score, reason
    FROM spam_quarantine
    WHERE ${where.join(" AND ")}
  `).all().map(row => ({ ...row, reason: JSON.parse(row.reason) }));
} catch (error) {
  if (missingTable(error)) { console.error("error: store has no spam_quarantine table — the quarantine journal (#557) never ran here"); process.exit(2); }
  console.error(`error: reading quarantine journal: ${error.message}`); process.exit(2);
}

let splitIds;
try {
  splitIds = new Set(db.prepare("SELECT quarantine_id FROM quarantine_thread_splits").all().map(r => r.quarantine_id));
} catch (error) {
  // Stores written before #562's thread-split table: zero splits, not a failure.
  if (!missingTable(error)) { console.error(`error: reading thread splits: ${error.message}`); process.exit(2); }
  splitIds = new Set();
}
db.close();

const report = reviewCoverageBySignal({ rows, splits: splitIds, now });

if (format === "json") {
  console.log(JSON.stringify({ ...report, rows: rows.map(r => ({ id: r.id, status: r.status, split: splitIds.has(r.id), signalKeys: r.reason.map(s => s.key) })) }, null, 2));
  process.exit(0);
}

const pct = value => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const { totals, zeroCoverageSignals, perSignal } = report;
const lines = [
  "Quarantine review coverage (per signal)",
  `  store:            ${storePath}`,
  `  window:           ${since === null ? "start" : new Date(since).toISOString()} .. ${until === null ? "now" : new Date(until).toISOString()}`,
  `  holds:            ${totals.total} (${totals.held} still awaiting review)`,
  `  reviewed:         ${totals.reviewed} — confirmed ${totals.confirmed} · dismissed ${totals.dismissed} · split ${totals.split}`,
  `  review coverage:  ${pct(totals.reviewCoverage)}  (reviewed / all holds, the #567 reviewCoverage ratio per signal below)`,
  "",
  `  ${"signal".padEnd(34)} ${"held".padStart(5)} ${"revd".padStart(5)} ${"conf".padStart(5)} ${"dism".padStart(5)} ${"split".padStart(6)} ${"cover".padStart(7)} ${"share".padStart(6)}`,
];
for (const signal of perSignal) {
  lines.push(`  ${signal.key.padEnd(34)} ${String(signal.held).padStart(5)} ${String(signal.reviewed).padStart(5)} ${String(signal.confirmed).padStart(5)} ${String(signal.dismissed).padStart(5)} ${String(signal.split).padStart(6)} ${pct(signal.reviewCoverage).padStart(7)} ${pct(signal.shareOfHolds).padStart(6)}`);
}
if (perSignal.length === 0) lines.push("  (no holds in window)");
lines.push("",
  "  conf = Confirmed (released into the inbox, verdict: not spam) · dism = Dismissed (confirmed spam, stays out) · split = Split off its thread (a thread action, not a verdict: split rows still need Confirm or Dismiss)");
if (zeroCoverageSignals.length > 0) {
  lines.push("", `  COVERAGE GAP: ${zeroCoverageSignals.length} signal(s) firing on live holds with zero owner review:`);
  for (const key of zeroCoverageSignals) lines.push(`    - ${key}`);
}
lines.push("", "per-row drill-down in --format json.");
console.log(lines.join("\n"));
