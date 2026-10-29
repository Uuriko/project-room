// Metric registry gate (freeze-now definitions, PR-IMPROVE-100
// dispositions 07-3 / 08-4 / 09-2 / 09-4 / 10-2; spec: cluster-07
// lane-10). The registry at metrics/registry.yaml is the single home
// for frozen product-metric definitions, product event-taxonomy
// definitions, and verdict reason codes. This lint enforces the five
// registry rules from the spec:
//
//   1. A ratio metric without a denominator fails (C13-D8 made
//      structural: every aggregate publishes its denominator).
//   2. A metric without a first_decision fails — a metric that informs
//      no decision is an ornament and cannot register.
//   3. A published report citing a metric id must cite its version
//      (accepted forms: id@version, id@vN, id (vN), id version N, with
//      N equal to the registry's current version for that id).
//   4. Editing a frozen definition (a metric's numerator/denominator,
//      an event's or reason code's definition) without a version bump
//      fails — checked against a base registry (see --base below).
//   5. Entries are never deleted. A retired metric, event, or reason
//      code stays in the file with status: killed (tombstone);
//      deleting an entry rewrites history and fails against the base.
//
// Rules 4–5 need a base: --base <git-ref> (or $METRIC_REGISTRY_BASE)
// reads metrics/registry.yaml at that ref; when no ref is given the
// gate probes origin/main and skips the diff rules if the registry
// does not exist there yet (the initial freeze has nothing to diff
// against). Structural checks (required fields, unique ids, valid
// status, a change_log entry for the current version) support the
// five rules and always run.
//
// Definitions only: this gate validates the artefact. It computes no
// metric and emits no event.
//
// Usage:
//   node scripts/metric-registry-check.mjs [--registry <path>]
//     [--base <git-ref>] [--scan <md file or dir> ...] [--no-scan]
// Default scan set: every .md file under metrics/ and docs/.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STATUSES = new Set(["adopted", "parked", "killed"]);
const METRIC_TYPES = new Set(["ratio", "count", "duration"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function changeLogCovers(entry, label, problems) {
  const log = entry.change_log;
  if (!Array.isArray(log) || log.length === 0) {
    problems.push(`${label}: change_log is missing or empty`);
    return;
  }
  if (!log.some(row => row && row.version === entry.version && isNonEmptyString(row.note))) {
    problems.push(`${label}: change_log has no entry for the current version (${entry.version})`);
  }
}

function checkCommon(entry, label, problems) {
  if (!entry || typeof entry !== "object") {
    problems.push(`${label}: entry is not a mapping`);
    return false;
  }
  if (!Number.isInteger(entry.version) || entry.version < 1) {
    problems.push(`${label}: version must be a positive integer`);
  }
  if (!STATUSES.has(entry.status)) {
    problems.push(`${label}: status must be one of adopted|parked|killed`);
  }
  if (!isNonEmptyString(entry.owner)) {
    problems.push(`${label}: owner is required (a named role, not a person-instance)`);
  }
  changeLogCovers(entry, label, problems);
  return true;
}

function lintMetrics(metrics, problems) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    problems.push("registry: metrics must be a non-empty list");
    return new Map();
  }
  const byId = new Map();
  for (const metric of metrics) {
    const id = metric && isNonEmptyString(metric.id) ? metric.id : "(missing id)";
    const label = `metric ${id}`;
    if (!checkCommon(metric, label, problems)) continue;
    if (!isNonEmptyString(metric.id)) problems.push("metric: id is required");
    if (byId.has(metric.id)) problems.push(`${label}: duplicate id`);
    byId.set(metric.id, metric);
    if (!isNonEmptyString(metric.name)) problems.push(`${label}: name is required`);
    if (!METRIC_TYPES.has(metric.type)) problems.push(`${label}: type must be one of ratio|count|duration`);
    if (!isNonEmptyString(metric.numerator)) problems.push(`${label}: numerator (frozen definition) is required`);
    // Rule 1: a ratio metric without a denominator fails.
    if (metric.type === "ratio" && !isNonEmptyString(metric.denominator)) {
      problems.push(`${label}: rule 1 — ratio metric without a denominator`);
    }
    // Rule 2: no first_decision, no registration.
    if (!isNonEmptyString(metric.first_decision)) {
      problems.push(`${label}: rule 2 — first_decision is required (a metric that informs no decision cannot register)`);
    }
    if (metric.source_events !== undefined && !Array.isArray(metric.source_events)) {
      problems.push(`${label}: source_events must be a list`);
    }
  }
  return byId;
}

function lintEvents(events, problems) {
  if (!Array.isArray(events)) {
    problems.push("registry: events must be a list");
    return new Map();
  }
  const byId = new Map();
  for (const event of events) {
    const id = event && isNonEmptyString(event.id) ? event.id : "(missing id)";
    const label = `event ${id}`;
    if (!checkCommon(event, label, problems)) continue;
    if (!isNonEmptyString(event.id) || !event.id.includes(".")) {
      problems.push(`${label}: event id must be a dotted name (family.name)`);
    }
    if (byId.has(event.id)) problems.push(`${label}: duplicate id`);
    byId.set(event.id, event);
    if (!isNonEmptyString(event.family)) problems.push(`${label}: family is required`);
    if (!isNonEmptyString(event.definition)) problems.push(`${label}: definition is required`);
    if (!Array.isArray(event.required_fields) || event.required_fields.length === 0) {
      problems.push(`${label}: required_fields must be a non-empty list (taxonomy freezes names + required fields)`);
    }
  }
  return byId;
}

function lintReasonCodes(codes, problems) {
  if (!Array.isArray(codes)) {
    problems.push("registry: verdict_reason_codes must be a list");
    return new Map();
  }
  const byCode = new Map();
  for (const entry of codes) {
    const code = entry && isNonEmptyString(entry.code) ? entry.code : "(missing code)";
    const label = `verdict reason code ${code}`;
    if (!checkCommon(entry, label, problems)) continue;
    if (!isNonEmptyString(entry.code)) problems.push("verdict reason code: code is required");
    if (byCode.has(entry.code)) problems.push(`${label}: duplicate code`);
    byCode.set(entry.code, entry);
    if (!isNonEmptyString(entry.definition)) problems.push(`${label}: definition is required`);
  }
  return byCode;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rule 3: a report citing a metric id must cite its current version.
export function citationProblems(metricsById, scanTexts) {
  const problems = [];
  for (const { path, text } of scanTexts) {
    const lines = text.split("\n");
    for (const [id, metric] of metricsById) {
      const pattern = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(id)}(?![A-Za-z0-9_.-])`, "g");
      lines.forEach((line, index) => {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const rest = line.slice(match.index + id.length);
          const versionMatch = rest.match(/^@v?(\d+)\b/) || rest.match(/^[\s(]+v(\d+)\b/) || rest.match(/^[\s(]+version\s+(\d+)\b/i);
          if (!versionMatch) {
            problems.push(`${path}:${index + 1}: rule 3 — cites ${id} without its version (cite ${id}@${metric.version})`);
          } else if (Number(versionMatch[1]) !== metric.version) {
            problems.push(`${path}:${index + 1}: rule 3 — cites ${id} at version ${versionMatch[1]}, registry is at version ${metric.version}`);
          }
        }
      });
    }
  }
  return problems;
}

// Rules 4–5, against a base registry (parsed data, or null to skip).
function diffProblems(current, base) {
  const problems = [];
  const sections = [
    { key: "metrics", idOf: entry => entry.id, kind: "metric", defFields: ["numerator", "denominator"] },
    { key: "events", idOf: entry => entry.id, kind: "event", defFields: ["definition"] },
    { key: "verdict_reason_codes", idOf: entry => entry.code, kind: "verdict reason code", defFields: ["definition"] },
  ];
  for (const { key, idOf, kind, defFields } of sections) {
    const baseById = new Map((base[key] || []).map(entry => [idOf(entry), entry]));
    const currentById = new Map((current[key] || []).map(entry => [idOf(entry), entry]));
    for (const [id, baseEntry] of baseById) {
      const currentEntry = currentById.get(id);
      // Rule 5: tombstones — an entry may be retired (status: killed),
      // never deleted.
      if (!currentEntry) {
        problems.push(`rule 5 — ${kind} ${id} was deleted; retired entries stay in the registry with status: killed`);
        continue;
      }
      if (Number.isInteger(currentEntry.version) && currentEntry.version < baseEntry.version) {
        problems.push(`rule 4 — ${kind} ${id}: version went backwards (${baseEntry.version} → ${currentEntry.version})`);
        continue;
      }
      // Rule 4: a frozen definition edit requires a version bump.
      const edited = defFields.some(field => String(baseEntry[field] ?? "").trim() !== String(currentEntry[field] ?? "").trim());
      if (edited && currentEntry.version <= baseEntry.version) {
        problems.push(`rule 4 — ${kind} ${id}: definition edited without a version bump (still version ${currentEntry.version})`);
      }
    }
  }
  return problems;
}

// Pure core: parsed registry data in, problem strings out.
// options: { baseData = null, scanTexts = [] }.
export function lintRegistryData(data, options = {}) {
  const problems = [];
  if (!data || typeof data !== "object") return ["registry: top level must be a mapping"];
  const metricsById = lintMetrics(data.metrics, problems);
  lintEvents(data.events, problems);
  lintReasonCodes(data.verdict_reason_codes, problems);
  if (Array.isArray(data.metrics) && data.metrics.length > 0) {
    problems.push(...citationProblems(metricsById, options.scanTexts || []));
  }
  if (options.baseData) problems.push(...diffProblems(data, options.baseData));
  return problems;
}

export function markdownFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith(".md") ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return entry.isFile() && entry.name.endsWith(".md") ? [child] : [];
  });
}

function readBaseRegistry(ref, registryPath, parseYaml) {
  try {
    const source = execFileSync("git", ["show", `${ref}:${registryPath}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseYaml(source);
  } catch {
    return null;
  }
}

function resolveBaseRef(explicitRef, registryPath, parseYaml) {
  if (explicitRef) return explicitRef;
  if (process.env.METRIC_REGISTRY_BASE) return process.env.METRIC_REGISTRY_BASE;
  try {
    execFileSync("git", ["cat-file", "-e", `origin/main:${registryPath}`], { stdio: "ignore" });
    return "origin/main";
  } catch {
    return null;
  }
}

async function main(argv) {
  let registryPath = "metrics/registry.yaml";
  let baseRef = null;
  const scanPaths = [];
  let scanDisabled = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--registry") registryPath = argv[++i];
    else if (argv[i] === "--base") baseRef = argv[++i];
    else if (argv[i] === "--scan") scanPaths.push(argv[++i]);
    else if (argv[i] === "--no-scan") scanDisabled = true;
    else {
      console.error(`metric-registry-check: unknown argument ${argv[i]}`);
      return 2;
    }
  }

  let parseYaml;
  try {
    ({ parse: parseYaml } = await import("yaml"));
  } catch {
    console.log("metric-registry-check: skipping (the yaml devDependency is not installed; run npm ci)");
    return 0;
  }

  let data;
  try {
    data = parseYaml(readFileSync(registryPath, "utf8"));
  } catch (error) {
    console.error(`METRIC-REGISTRY: ${registryPath}: ${error.message}`);
    return 1;
  }

  const effectiveScanPaths = scanDisabled ? [] : (scanPaths.length > 0 ? scanPaths : ["metrics", "docs"]);
  const scanTexts = effectiveScanPaths
    .flatMap(markdownFiles)
    .map(path => ({ path, text: readFileSync(path, "utf8") }));

  const resolvedBase = resolveBaseRef(baseRef, registryPath, parseYaml);
  const baseData = resolvedBase ? readBaseRegistry(resolvedBase, registryPath, parseYaml) : null;
  if (resolvedBase && !baseData) {
    console.log(`metric-registry-check: base ${resolvedBase} has no ${registryPath}; diff rules (4–5) skipped`);
  }

  const problems = lintRegistryData(data, { baseData, scanTexts });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`METRIC-REGISTRY: ${problem}`);
    console.error(`FAIL: metric registry lint found ${problems.length} problem(s) in ${registryPath}`);
    return 1;
  }
  const metricCount = Array.isArray(data.metrics) ? data.metrics.length : 0;
  const eventCount = Array.isArray(data.events) ? data.events.length : 0;
  const codeCount = Array.isArray(data.verdict_reason_codes) ? data.verdict_reason_codes.length : 0;
  console.log(`metric-registry-check: ${registryPath} OK (${metricCount} metrics, ${eventCount} events, ${codeCount} verdict reason codes${baseData ? `, diff rules checked against ${resolvedBase}` : ""})`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
