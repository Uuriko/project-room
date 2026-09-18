// Post-shadow precision report for auto-quarantine (AUTO-QUARANTINE-POLICY.md §5).
//
// Reads a room store READ-ONLY (PRAGMA query_only) and joins the shadow
// would-be-hold records (receipt.shadowQuarantine on source.import receipts,
// server/spam-shadow.mjs) to the review outcomes in the durable
// spam_quarantine journal (server/spam-quarantine-journal.mjs), using the join
// and labeling logic in server/spam-shadow-report.mjs.
//
// Usage:
//   node scripts/shadow-quarantine-report.mjs --store /path/to/room.db \
//     [--since 2026-09-18T00:00:00Z | --since <ms-epoch>] [--until ...] \
//     [--review-window-days 14] [--now <ms-epoch>] [--format text|json]
//
// --since/--until filter shadow decisions by their decision time (the policy's
//   shadow window); review outcomes join regardless of when the review landed.
// --review-window-days: a still-held match older than this is expired_unreviewed
//   instead of pending_review (default 14, the policy's shadow period).
// --now: override "today" for repeatable reports (default: Date.now()).
//
// Exit 0 with the report on stdout. No writes, no network, no sends.
import { DatabaseSync } from "node:sqlite";
import { shadowPrecisionReport, shadowReviewWindowMs } from "../server/spam-shadow-report.mjs";

const usage = `shadow-quarantine-report.mjs --store <room.db> [options]

Reads a room store read-only and reports auto-quarantine shadow precision.

Options:
  --store <path>            room store sqlite file (required)
  --since <date|epoch>      include decisions at/after this time
  --until <date|epoch>      include decisions before this time
  --review-window-days <n>  held matches older than this are expired (default 14)
  --now <epoch>             override "now" (default: current time)
  --format text|json        output format (default: text)
  --help                   this message`;

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
const windowDays = Number(get("--review-window-days") ?? 14);
if (!Number.isFinite(windowDays) || windowDays <= 0) { console.error("error: --review-window-days must be positive"); process.exit(2); }
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
let decisions;
try {
  const rows = db.prepare(`
    SELECT account_id AS accountId,
      json_extract(receipt_json, '$.sourceId') AS sourceId,
      json_extract(receipt_json, '$.shadowQuarantine') AS shadow
    FROM private_inbox_commands
    WHERE json_extract(request_json, '$.action') = 'source.import'
      AND json_type(receipt_json, '$.shadowQuarantine') = 'object'
  `).all();
  decisions = rows
    .map(row => {
      const shadow = JSON.parse(row.shadow);
      return { ...shadow,
        accountId: row.accountId ?? null,
        sourceId: row.sourceId ?? shadow.sourceId ?? null,
        features: Array.isArray(shadow.features) ? shadow.features : [] };
    })
    .filter(d => d.messageId && (since === null || d.at >= since) && (until === null || d.at < until));
} catch (error) {
  if (missingTable(error)) { console.error("error: store has no private_inbox_commands table — not a room inbox store"); process.exit(2); }
  console.error(`error: reading shadow decisions: ${error.message}`); process.exit(2);
}

let reviews;
try {
  reviews = db.prepare(`
    SELECT id, message_id AS messageId, channel, connection_id AS connectionId,
      account_id AS accountId, source_id AS sourceId, score,
      quarantined_at AS quarantinedAt, status, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt
    FROM spam_quarantine
  `).all();
} catch (error) {
  if (missingTable(error)) { console.error("error: store has no spam_quarantine table — shadow instrumentation (#565) / quarantine journal (#560) never ran here"); process.exit(2); }
  console.error(`error: reading quarantine journal: ${error.message}`); process.exit(2);
}
db.close();

const report = shadowPrecisionReport({ decisions, reviews, now,
  reviewWindowMs: (windowDays / 14) * shadowReviewWindowMs });

if (format === "json") {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = value => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const { metrics, counts, perSignal, gateBlocks } = report;
const lines = [
  "Auto-quarantine shadow report",
  `  store:            ${storePath}`,
  `  window:           ${since === null ? "start" : new Date(since).toISOString()} .. ${until === null ? "now" : new Date(until).toISOString()}`,
  `  decisions:        ${decisions.length} scored imports in window`,
  `  would-be holds:   ${metrics.wouldBeHolds}`,
  `  reviewed holds:   ${metrics.reviewedHolds} (coverage ${pct(metrics.reviewCoverage)})`,
  "",
  "Outcomes (labels):",
  ...["true_positive", "false_positive", "pending_review", "expired_unreviewed",
    "unjournaled", "false_negative", "true_negative"]
    .map(label => `  ${label.padEnd(18)} ${counts[label]}`),
  "",
  "Metrics (over reviewed would-be holds):",
  `  precision          ${pct(metrics.precision)}  (policy §5 bar: false-positive rate ~<=5%)`,
  `  false-positive     ${pct(metrics.falsePositiveRate)}`,
  `  recall             ${pct(metrics.recall)}  (TP / (TP + dismissed-but-not-held))`,
  "",
  "Per-signal breakdown (fired on would-be holds):",
  `  ${"signal".padEnd(32)} ${"holds".padStart(6)} ${"reviewed".padStart(8)} ${"TP".padStart(4)} ${"FP".padStart(4)} ${"prec".padStart(7)} ${"share".padStart(6)}`,
];
for (const signal of perSignal) {
  lines.push(`  ${signal.key.padEnd(32)} ${String(signal.wouldBeHolds).padStart(6)} ${String(signal.reviewed).padStart(8)} ${String(signal.truePositives).padStart(4)} ${String(signal.falsePositives).padStart(4)} ${pct(signal.precision).padStart(7)} ${pct(signal.shareOfHolds).padStart(6)}`);
}
if (perSignal.length === 0) lines.push("  (no would-be holds)");
lines.push("", "Gate blocks (score >= threshold but NOT held):");
for (const [gate, bucket] of Object.entries(gateBlocks)) {
  lines.push(`  ${gate.padEnd(20)} n=${bucket.count} dismissed=${bucket.dismissed} released=${bucket.released} held=${bucket.held} neverJournaled=${bucket.neverJournaled}`);
}
if (Object.keys(gateBlocks).length === 0) lines.push("  (none)");
if (report.policyVersions.length > 1) lines.push("", `WARNING: ${report.policyVersions.length} policy versions in window: ${report.policyVersions.join(", ")}`);
if (report.ambiguousMatches > 0) lines.push("", `note: ${report.ambiguousMatches} ambiguous messageId matches (multiple journal rows, latest verdict used)`);
lines.push("", "rows[] in --format json hold the labeled per-decision drill-down.");
console.log(lines.join("\n"));
