// Weekly dependency audit: run `npm audit --json` through an injectable
// runner, group vulnerabilities by severity, and emit a Markdown report plus
// a JSON summary. Designed for cron/CI: exit 0 when the audit is clean or
// below --fail-on, exit 1 when vulnerabilities at or above the threshold
// exist (so CI can gate on it), exit 2 when the audit itself failed.
//
// Usage:
//   node scripts/dependency-audit.mjs [--fail-on=<severity>] [--out=<path>] [--json-out=<path>]
//   node scripts/dependency-audit.mjs --help
//
// Pure functions (parseAuditJson, groupBySeverity, summarizeAudit,
// thresholdBreached, renderMarkdown, renderJsonSummary) carry the logic and
// are unit-tested in tests/dependency-audit.test.js with fixture payloads;
// only the npm invocation goes through the injectable runner.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

export class AuditError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "AuditError";
  }
}

function normalizeSeverity(raw) {
  const severity = String(raw ?? "").toLowerCase();
  if (!SEVERITIES.includes(severity)) throw new AuditError(`Unknown severity "${raw}"`);
  return severity;
}

// Parse raw `npm audit --json` text into a flat list of vulnerability records.
// Handles the npm >=7 shape ({ vulnerabilities: {...} }) and the npm 6
// advisory shape ({ advisories: {...} }). Throws AuditError on malformed
// JSON, on an npm error payload, or on a payload with no recognizable shape.
export function parseAuditJson(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ""));
  } catch (cause) {
    throw new AuditError("npm audit output is not valid JSON", cause);
  }
  if (!payload || typeof payload !== "object") throw new AuditError("npm audit output is not a JSON object");
  if (payload.error && [payload.error.code, payload.error.summary, payload.error.detail].some(Boolean)) {
    const { code, summary, detail } = payload.error;
    throw new AuditError(`npm audit failed: ${[code, summary, detail].filter(Boolean).join(" — ")}`);
  }
  // npm prints its own error JSON (not an audit report) when the audit
  // endpoint fails, e.g. registry 403: { message, method, uri, statusCode }.
  if (typeof payload.message === "string" && (payload.statusCode != null || payload.method != null)) {
    throw new AuditError(`npm audit failed: ${payload.message}`);
  }
  const vulnerabilities = [];
  if (payload.vulnerabilities && typeof payload.vulnerabilities === "object") {
    for (const [key, entry] of Object.entries(payload.vulnerabilities)) {
      if (!entry || typeof entry !== "object") continue;
      vulnerabilities.push({
        name: entry.name ?? key,
        severity: normalizeSeverity(entry.severity),
        title: entry.title ?? null,
        url: entry.url ?? null,
        range: entry.range ?? null,
        fixAvailable: entry.fixAvailable ?? null,
      });
    }
    return { vulnerabilities, source: "npm-v7" };
  }
  if (payload.advisories && typeof payload.advisories === "object") {
    for (const advisory of Object.values(payload.advisories)) {
      if (!advisory || typeof advisory !== "object") continue;
      vulnerabilities.push({
        name: advisory.module_name ?? "unknown",
        severity: normalizeSeverity(advisory.severity),
        title: advisory.title ?? null,
        url: advisory.url ?? null,
        range: advisory.vulnerable_versions ?? null,
        fixAvailable: null,
      });
    }
    return { vulnerabilities, source: "npm-v6" };
  }
  throw new AuditError("npm audit output has no vulnerabilities/advisories section");
}

// Group vulnerability records by severity, in severity order. Every severity
// key is present (empty arrays when there are none).
export function groupBySeverity(vulnerabilities) {
  const groups = Object.fromEntries(SEVERITIES.map((s) => [s, []]));
  for (const vuln of vulnerabilities ?? []) {
    groups[normalizeSeverity(vuln.severity)].push(vuln);
  }
  return groups;
}

// Roll grouped/count data into a compact summary.
export function summarizeAudit(vulnerabilities) {
  const groups = groupBySeverity(vulnerabilities);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, groups[s].length]));
  const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
  const present = SEVERITIES.filter((s) => counts[s] > 0);
  return {
    total,
    counts,
    highest: present.length > 0 ? present[present.length - 1] : null,
    groups,
  };
}

export function normalizeThreshold(raw) {
  const threshold = String(raw ?? "high").toLowerCase();
  if (!SEVERITIES.includes(threshold)) {
    throw new AuditError(`Unknown --fail-on severity "${raw}"; expected one of ${SEVERITIES.join(", ")}`);
  }
  return threshold;
}

// True when any vulnerability sits at or above the threshold severity.
export function thresholdBreached(summary, threshold) {
  const level = normalizeThreshold(threshold);
  return SEVERITIES.slice(RANK[level]).some((s) => (summary.counts[s] ?? 0) > 0);
}

export function renderMarkdown(summary, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    "# Weekly Dependency Audit",
    "",
    `_Generated ${generatedAt}_`,
    "",
    `**Total vulnerabilities:** ${summary.total}`,
    "",
    "| Severity | Count |",
    "| --- | --- |",
    ...[...SEVERITIES].reverse().map((s) => `| ${s} | ${summary.counts[s]} |`),
  ];
  const findings = SEVERITIES.filter((s) => summary.counts[s] > 0);
  if (findings.length === 0) {
    lines.push("", "No vulnerabilities found. 🎉");
  } else {
    lines.push("", "## Findings", "");
    for (const severity of [...SEVERITIES].reverse()) {
      for (const vuln of summary.groups[severity]) {
        lines.push(`- **${severity}** — \`${vuln.name}\`${vuln.range ? ` (${vuln.range})` : ""}${vuln.title ? ` — ${vuln.title}` : ""}${vuln.url ? ` ([advisory](${vuln.url}))` : ""}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderJsonSummary(summary, { threshold = "high", breached = false, generatedAt = new Date().toISOString() } = {}) {
  return JSON.stringify({
    tool: "dependency-audit",
    generatedAt,
    threshold,
    breached,
    total: summary.total,
    counts: summary.counts,
    highest: summary.highest,
    findings: SEVERITIES.filter((s) => summary.counts[s] > 0).flatMap((s) =>
      summary.groups[s].map((v) => ({ name: v.name, severity: v.severity, title: v.title, url: v.url, range: v.range }))
    ),
  }, null, 2);
}

// Default runner: `npm audit --json`. npm exits non-zero when it finds
// vulnerabilities, so stdout is recovered from the spawn error too. Anything
// else (no JSON on stdout) becomes an AuditError.
export async function defaultRunner({ cwd = process.cwd() } = {}) {
  try {
    const { stdout } = await execFileAsync("npm", ["audit", "--json", "--no-color"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return String(stdout ?? "");
  } catch (err) {
    const stdout = err && err.stdout != null ? String(err.stdout) : "";
    if (stdout.trim() !== "") return stdout;
    throw new AuditError("npm audit exited without JSON output", err);
  }
}

// Run the audit through any async runner (default: npm). Returns the parsed
// payload, summary, and breach verdict for the given threshold.
export async function runAudit({ runner = defaultRunner, threshold = "high", cwd } = {}) {
  const raw = await runner({ cwd });
  const parsed = parseAuditJson(raw);
  const summary = summarizeAudit(parsed.vulnerabilities);
  const breached = thresholdBreached(summary, threshold);
  return { ...parsed, summary, threshold: normalizeThreshold(threshold), breached };
}

function usage() {
  return [
    "Usage: node scripts/dependency-audit.mjs [options]",
    "",
    "Options:",
    "  --fail-on=<severity>  Exit 1 when vulnerabilities at/above this severity exist",
    `                        (one of: ${SEVERITIES.join(", ")}; default: high)`,
    "  --out=<path>          Write the Markdown report to <path> (also printed to stdout)",
    "  --json-out=<path>     Write the JSON summary to <path>",
    "  --help                Print this help",
    "",
    "Exit codes: 0 = clean/below threshold, 1 = threshold breached, 2 = audit failed.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { failOn: "high", out: null, jsonOut: null, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--fail-on=")) options.failOn = arg.slice("--fail-on=".length);
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg.startsWith("--json-out=")) options.jsonOut = arg.slice("--json-out=".length);
    else throw new AuditError(`Unknown argument "${arg}"`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  let result;
  try {
    result = await runAudit({ threshold: options.failOn });
  } catch (err) {
    console.error(`dependency-audit: ${err.message}`);
    process.exit(2);
  }
  const markdown = renderMarkdown(result.summary);
  const jsonSummary = renderJsonSummary(result.summary, { threshold: result.threshold, breached: result.breached });
  if (options.out) writeFileSync(options.out, markdown);
  if (options.jsonOut) writeFileSync(options.jsonOut, `${jsonSummary}\n`);
  process.stdout.write(markdown);
  if (result.breached) {
    console.error(`dependency-audit: FAIL — vulnerabilities at/above "${result.threshold}" found`);
    process.exit(1);
  }
  console.error("dependency-audit: PASS — no vulnerabilities at/above threshold");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
