#!/usr/bin/env node
/**
 * render-calendar.mjs — load-calendar guild, calendar-view slice (w2).
 *
 * Renders a markdown "load calendar" from a probing-intent registry.
 *
 * Usage:
 *   node render-calendar.mjs --registry <file.json> --out <file.md>
 *   node render-calendar.mjs --help
 *
 * Stdlib only, no dependencies.
 *
 * Behavior:
 * - Reads the registry as a JSON array of intent records (also tolerates an
 *   envelope object shaped { intents: [...] }).
 * - Gracefully handles a missing file or an empty registry: renders a
 *   "no intents registered" page and exits 0.
 * - Only counts intents whose status is in { planned, active }.
 * - Buckets intents into 15-minute UTC buckets across the union of their
 *   windows. An intent is active in a bucket if its window overlaps the
 *   bucket interval (window_end is exclusive).
 * - For each bucket, per target: active intent count, aggregate rate_rps
 *   (sum), and max concurrent overlap count (equal to active count at this
 *   bucket granularity — every intent active in the same bucket overlaps it).
 * - Emits a markdown timeline (bucket -> per-target rows) plus an aggregate
 *   table (target -> total intents, peak aggregate rps, peak concurrency).
 *   Buckets are sorted chronologically.
 */

import { readFileSync, writeFileSync } from "node:fs";

const BUCKET_MS = 15 * 60 * 1000;
const COUNTED_STATUSES = new Set(["planned", "active"]);

function usage(exitCode = 0) {
  const msg = [
    "Usage:",
    "  node render-calendar.mjs --registry <file.json> --out <file.md>",
    "",
    "Options:",
    "  --registry <file>   JSON array of intent records (per PROBING-INTENT-CONVENTION.md)",
    "  --out <file>        Markdown file to write the calendar to",
    "  --help              Show this help",
  ].join("\n");
  process.stdout.write(msg + "\n");
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { registry: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--registry") args.registry = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      usage(1);
    }
  }
  if (!args.registry || !args.out) {
    process.stderr.write("error: --registry and --out are both required\n");
    usage(1);
  }
  return args;
}

/** @returns {{ intents: object[]|null, missing: boolean, broken: boolean }} */
function loadRegistry(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { intents: null, missing: true, broken: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { intents: null, missing: false, broken: true };
  }
  const arr = Array.isArray(parsed) ? parsed : parsed?.intents;
  if (!Array.isArray(arr)) return { intents: null, missing: false, broken: true };
  return { intents: arr, missing: false, broken: false };
}

function bucketFloor(ms) {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/** "2026-10-08 03:00 UTC" */
function fmtBucket(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function main() {
  const { registry, out } = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();
  const lines = [];
  const head = (s) => lines.push(s);

  head("# Load Calendar");
  head("");
  head(`_Generated ${nowIso} · registry: \`${registry}\`_`);
  head("");

  const { intents, missing, broken } = loadRegistry(registry);

  if (missing) {
    head("## No intents registered");
    head("");
    head("The registry file was not found — no probing intents are on record.");
    head("Register an intent before probing (see PROBING-INTENT-CONVENTION.md).");
    head("");
    writeFileSync(out, lines.join("\n"), "utf8");
    process.stdout.write(`wrote ${out} (registry missing: no intents registered)\n`);
    return;
  }
  if (broken) {
    head("## No intents registered");
    head("");
    head(
      "The registry file could not be parsed as a JSON array of intent records — " +
        "treating it as empty until fixed."
    );
    head("");
    writeFileSync(out, lines.join("\n"), "utf8");
    process.stderr.write(`warning: registry ${registry} is not valid JSON array; rendered empty\n`);
    process.stdout.write(`wrote ${out} (registry unreadable: no intents registered)\n`);
    return;
  }

  // Split counted vs skipped intents.
  const counted = [];
  const skipped = [];
  for (const rec of intents) {
    if (!rec || typeof rec !== "object") {
      skipped.push({ intent_id: "(malformed record)", reason: "not an object" });
      continue;
    }
    const { intent_id, status, window_start, window_end, target, rate_rps } = rec;
    if (!COUNTED_STATUSES.has(status)) {
      skipped.push({ intent_id: intent_id ?? "(no id)", reason: `status '${status}' not counted` });
      continue;
    }
    const start = Date.parse(window_start);
    const end = Date.parse(window_end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skipped.push({ intent_id: intent_id ?? "(no id)", reason: "invalid window" });
      continue;
    }
    const rps = Number(rate_rps);
    if (!Number.isFinite(rps) || rps < 0) {
      skipped.push({ intent_id: intent_id ?? "(no id)", reason: "invalid rate_rps" });
      continue;
    }
    counted.push({
      intent_id: String(intent_id ?? "(no id)"),
      guild: String(rec.guild ?? "?"),
      contact: String(rec.contact ?? "?"),
      target: String(target ?? "(no target)"),
      kind: String(rec.kind ?? "?"),
      rate_rps: rps,
      window_start: start,
      window_end: end,
      scratch_only: Boolean(rec.scratch_only),
      ramp: String(rec.ramp ?? "?"),
      status,
    });
  }

  if (counted.length === 0) {
    head("## No intents registered");
    head("");
    head(
      `No intents with status in {planned, active} were found in the registry ` +
        `(${intents.length} record(s) total, ${skipped.length} skipped).`
    );
    head("");
    writeFileSync(out, lines.join("\n"), "utf8");
    process.stdout.write(`wrote ${out} (0 counted intents: no intents registered)\n`);
    return;
  }

  // Bucket intents across the union of windows.
  /** @type {Map<number, Map<string, {intents: typeof counted}>>} */
  const buckets = new Map();
  for (const rec of counted) {
    for (let b = bucketFloor(rec.window_start); b < rec.window_end; b += BUCKET_MS) {
      const bucketStart = b;
      const bucketEnd = b + BUCKET_MS;
      if (rec.window_start < bucketEnd && rec.window_end > bucketStart) {
        if (!buckets.has(bucketStart)) buckets.set(bucketStart, new Map());
        const byTarget = buckets.get(bucketStart);
        if (!byTarget.has(rec.target)) byTarget.set(rec.target, { intents: [] });
        byTarget.get(rec.target).intents.push(rec);
      }
    }
  }

  const sortedBuckets = [...buckets.keys()].sort((a, b) => a - b);
  const allTargets = new Set(counted.map((r) => r.target));

  head("## Overview");
  head("");
  head(`- Counted intents (status planned/active): **${counted.length}**`);
  head(`- Targets covered: **${allTargets.size}**`);
  head(`- Window span: ${fmtBucket(sortedBuckets[0])} → ${fmtBucket(sortedBuckets[sortedBuckets.length - 1] + BUCKET_MS)}`);
  head(`- Bucket size: 15 minutes (UTC)`);
  head(`- Skipped records (done/aborted/invalid): ${skipped.length}`);
  head("");

  // Timeline: bucket -> per-target rows.
  head("## Timeline");
  head("");
  head("For each 15-minute UTC bucket, per-target: active intents, aggregate rps (sum), max concurrent overlap.");
  head("");

  for (const b of sortedBuckets) {
    head(`### ${fmtBucket(b)} → ${fmtBucket(b + BUCKET_MS)}`);
    head("");
    head("| Target | Active intents | Agg. rps | Max concurrency | Intents (guild) |");
    head("|---|---|---|---|---|");
    const byTarget = buckets.get(b);
    for (const target of [...byTarget.keys()].sort()) {
      const { intents: recs } = byTarget.get(target);
      const count = recs.length;
      const agg = recs.reduce((s, r) => s + r.rate_rps, 0);
      // At 15-min granularity every intent active in the bucket overlaps it,
      // so max concurrent overlap == active intent count.
      const who = recs
        .map((r) => `\`${r.intent_id}\` (${r.guild})`)
        .sort()
        .join(", ");
      head(`| \`${target}\` | ${count} | ${agg.toFixed(2)} | ${count} | ${who} |`);
    }
    head("");
  }

  // Aggregate table: target -> total intents, peak aggregate rps, peak concurrency.
  head("## Aggregate by target");
  head("");
  head("| Target | Total intents | Peak agg. rps | Peak concurrency | Peak rps bucket | Kinds |");
  head("|---|---|---|---|---|---|");
  for (const target of [...allTargets].sort()) {
    const recs = counted.filter((r) => r.target === target);
    let peakRps = 0;
    let peakConc = 0;
    let peakBucket = "-";
    for (const b of sortedBuckets) {
      const cell = buckets.get(b).get(target);
      if (!cell) continue;
      const agg = cell.intents.reduce((s, r) => s + r.rate_rps, 0);
      const conc = cell.intents.length;
      if (agg > peakRps) {
        peakRps = agg;
        peakBucket = `${fmtBucket(b)} → ${fmtBucket(b + BUCKET_MS)}`;
      }
      if (conc > peakConc) peakConc = conc;
    }
    const kinds = [...new Set(recs.map((r) => r.kind))].sort().join(", ");
    head(`| \`${target}\` | ${recs.length} | ${peakRps.toFixed(2)} | ${peakConc} | ${peakBucket} | ${kinds} |`);
  }
  head("");

  if (skipped.length > 0) {
    head("## Skipped records");
    head("");
    for (const s of skipped) {
      head(`- \`${s.intent_id}\`: ${s.reason}`);
    }
    head("");
  }

  writeFileSync(out, lines.join("\n"), "utf8");
  process.stdout.write(
    `wrote ${out} (${counted.length} counted intents, ${sortedBuckets.length} buckets, ${allTargets.size} targets)\n`
  );
}

main();
