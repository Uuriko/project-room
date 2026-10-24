// #3678 gate: wall-clock budget assertions are banned from the unit suite.
//
// AUTHORING RULE — this is the rule the lint reports when it fails:
//   Do not assert on wall-clock time in unit tests. A performance.now() /
//   Date.now() delta, or a percentile computed from wall-clock samples,
//   compared against a fixed millisecond budget measures the runner's
//   load, not the code (the failure shape that quarantined the original
//   Board-list p95 test). Two sanctioned shapes exist:
//     1. Price the budget in CPU time instead — process.cpuUsage() deltas
//        over multiple samples, the #3289 pattern (see
//        tests/work-claim-integrity.test.js). CPU-priced assertions are
//        not flagged by this lint.
//     2. If the budget is genuinely a wall-clock budget, the test belongs
//        to the priced harness — the permitted set named in
//        tests/fixtures/timing-tests-registry.json — never the unit suite.
//   Assertions that predate the gate are grandfathered in
//   tests/fixtures/timing-assertions-baseline.json. That baseline may
//   only shrink: fixing or deleting a grandfathered assertion means
//   deleting its baseline entry in the same change, and no entry may be
//   added. Relative comparisons (warm vs cold, p95 vs 2x p95) and
//   percentile math over synthetic data are not budgets and are not
//   flagged.
//
// The lint is line-based, mirroring scripts/lint-design-tokens.mjs: it
// tracks, per file, the identifiers assigned from wall-clock deltas and
// the sample collections fed by wall-clock vs CPU deltas, then flags
// assertion lines that compare any of them — or a percentile/percentile
// property — against a fixed numeric threshold.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(ROOT, "tests");
const SELF = "tests/timing-assertions-lint.test.js";
const BASELINE_PATH = join(TESTS, "fixtures/timing-assertions-baseline.json");
const REGISTRY_PATH = join(TESTS, "fixtures/timing-tests-registry.json");

const AUTHORING_RULE = "RULE (#3678): no wall-clock budget assertions in the unit suite — price the budget in CPU time (process.cpuUsage deltas, the #3289 pattern in tests/work-claim-integrity.test.js) or move the test to the priced harness named in tests/fixtures/timing-tests-registry.json. Do not add entries to tests/fixtures/timing-assertions-baseline.json; it may only shrink.";

const NOW = String.raw`(?:performance|Date)\.now\(\)`;
const CMP = String.raw`(?:<|<=|>|>=)`;
const NUM = String.raw`\d+(?:\.\d+)?`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const re = (source, flags) => new RegExp(source, flags);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    // Authored test files only: dotfiles and *.generated.* files under
    // tests/ are artifacts other tests write mid-run (e.g.
    // tests/.webhook-dispatch-store.<hash>.generated.mjs), not authored
    // assertions — and whether they exist depends on run order.
    else if ((e.name.endsWith(".js") || e.name.endsWith(".mjs")) && !e.name.startsWith(".") && !e.name.includes(".generated.")) yield p;
  }
}

const normalizeLine = line => line.trim().replace(/\s+/g, " ");

// Budget-shaped hits in one file's text: [{line (1-based), rule, text}].
export function timingHits(text) {
  const lines = text.split("\n");
  const deltaVars = new Set();
  const assignDelta = re(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*(?:await\s+)?${NOW}\s*-`);
  for (const l of lines) {
    const m = assignDelta.exec(l);
    if (m) deltaVars.add(m[1]);
  }
  // A helper that returns a wall-clock delta makes its callers' elapsed /
  // duration results wall-clock measurements too (one level, name-scoped).
  if (lines.some(l => re(String.raw`return\s+${NOW}\s*-`).test(l))) {
    const helperAssign = re(String.raw`\b(?:const|let|var)\s+(elapsed|duration|tookMs|wallMs|latencyMs)\s*=\s*await\b`);
    for (const l of lines) {
      const m = helperAssign.exec(l);
      if (m) deltaVars.add(m[1]);
    }
  }
  const cpuVars = new Set();
  const assignCpu = re(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*process\.cpuUsage\(`);
  for (const l of lines) {
    const m = assignCpu.exec(l);
    if (m) cpuVars.add(m[1]);
  }
  const wallSamples = new Set();
  const cpuSamples = new Set();
  const pushRe = re(String.raw`(${IDENT}(?:\.get\([^)]*\))?)\.push\((.*)\)`);
  for (const l of lines) {
    const m = pushRe.exec(l);
    if (!m) continue;
    const root = m[1].split(".")[0];
    const expr = m[2];
    if (re(String.raw`${NOW}\s*-`).test(expr) || [...deltaVars].some(v => re(String.raw`\b${escapeRe(v)}\b`).test(expr))) wallSamples.add(root);
    if (expr.includes("cpuUsage") || [...cpuVars].some(v => re(String.raw`\b${escapeRe(v)}\b`).test(expr))) cpuSamples.add(root);
  }
  // Percentile variables and the timing source of their samples. A
  // percentile priced from CPU samples is the sanctioned #3289 pattern
  // and is never flagged; wall or unclassifiable sources fail closed.
  const pctVars = new Map();
  const assignPct = re(String.raw`\b(?:const|let|var)\s+(p\d{2}[\w$]*)\s*=\s*(.+)$`);
  for (const l of lines) {
    const m = assignPct.exec(l);
    if (!m) continue;
    const [, name, expr] = m;
    if (!expr.includes("percentile(") && !/\[Math\.ceil\(/.test(expr) && !expr.includes("samples[")) continue;
    const roots = new Set(expr.match(new RegExp(IDENT, "g")) ?? []);
    pctVars.set(name, [...roots].some(r => wallSamples.has(r)) ? "wall" : [...roots].some(r => cpuSamples.has(r)) ? "cpu" : "unknown");
  }

  const hits = [];
  lines.forEach((l, i) => {
    if (!l.includes("assert")) return;
    const text = normalizeLine(l);
    if (re(String.raw`${NOW}\s*-\s*[\w$]+`).test(l) && re(String.raw`${CMP}\s*${NUM}`).test(l)) {
      hits.push({ line: i + 1, rule: "direct-delta", text });
      return;
    }
    for (const v of deltaVars) {
      if (re(String.raw`\b${escapeRe(v)}\s*${CMP}\s*${NUM}`).test(l) || re(String.raw`${NUM}\s*${CMP}\s*${escapeRe(v)}\b`).test(l)) {
        hits.push({ line: i + 1, rule: "delta-var", text });
        return;
      }
    }
    if (re(String.raw`\.p(?:50|90|95|99)\b[^=]*?(?:<|<=)\s*[1-9]\d*(?:\.\d+)?`).test(l) || re(String.raw`percentile\([^)]*\)\s*(?:<|<=)\s*[1-9]`).test(l)) {
      hits.push({ line: i + 1, rule: "percentile-budget", text });
      return;
    }
    for (const [v, src] of pctVars) {
      if (src === "cpu") continue;
      if (re(String.raw`\b${escapeRe(v)}\s*(?:<|<=)\s*[1-9]`).test(l)) {
        hits.push({ line: i + 1, rule: "percentile-var", text });
        return;
      }
    }
  });
  return hits;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("timing registry names the permitted priced-harness set (#3678)", () => {
  const registry = loadJson(REGISTRY_PATH);
  assert.ok(Array.isArray(registry.permitted) && registry.permitted.length > 0, "registry must name at least the current priced-harness file");
  const seen = new Set();
  for (const entry of registry.permitted) {
    assert.ok(typeof entry.file === "string" && entry.file.startsWith("tests/"), `registry entry must name a tests/ file: ${JSON.stringify(entry)}`);
    assert.ok(!seen.has(entry.file), `registry repeats ${entry.file}`);
    seen.add(entry.file);
    assert.ok(existsSync(join(ROOT, entry.file)), `registry names ${entry.file}, which does not exist`);
    assert.ok(typeof entry.kind === "string" && entry.kind.length > 0, `registry entry for ${entry.file} must state its kind`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length >= 16, `registry entry for ${entry.file} must state why it is permitted`);
  }
});

test("no wall-clock budget assertions outside the priced harness (#3678)", () => {
  const baseline = loadJson(BASELINE_PATH);
  const registry = loadJson(REGISTRY_PATH);
  const pricedHarness = new Set(registry.permitted.filter(e => e.kind === "priced-harness").map(e => e.file));
  const key = (file, rule, text) => `${file} :: ${rule} :: ${text}`;
  const baselineKeys = new Set(baseline.entries.map(e => key(e.file, e.rule, normalizeLine(e.line))));
  assert.equal(baselineKeys.size, baseline.entries.length, "timing baseline must not repeat an entry");

  const liveKeys = new Set();
  const unbaselined = [];
  for (const path of walk(TESTS)) {
    const file = relative(ROOT, path).split(sep).join("/");
    if (file === SELF || pricedHarness.has(file)) continue;
    for (const hit of timingHits(readFileSync(path, "utf8"))) {
      const k = key(file, hit.rule, hit.text);
      liveKeys.add(k);
      if (!baselineKeys.has(k)) unbaselined.push(`${file}:${hit.line} [${hit.rule}] ${hit.text}`);
    }
  }
  assert.deepEqual(unbaselined, [], `wall-clock budget assertions not in the grandfather baseline:\n${unbaselined.join("\n")}\n${AUTHORING_RULE}`);

  const stale = [...baselineKeys].filter(k => !liveKeys.has(k));
  assert.deepEqual(stale, [], `grandfathered timing assertions that no longer exist — delete these baseline entries (the baseline only shrinks):\n${stale.join("\n")}`);
});
