// F006: weekly dependency audit automation. The npm invocation is injectable
// (runAudit takes a runner), so these tests use fixture `npm audit --json`
// payloads and never touch the network or the real dependency tree.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEVERITIES,
  AuditError,
  parseAuditJson,
  groupBySeverity,
  summarizeAudit,
  normalizeThreshold,
  thresholdBreached,
  renderMarkdown,
  renderJsonSummary,
  runAudit,
  parseArgs,
} from "../scripts/dependency-audit.mjs";

// npm >=7 shape: { vulnerabilities: { name: {...} } }
const NPM7_MIXED = JSON.stringify({
  vulnerabilities: {
    "left-pad": {
      name: "left-pad",
      severity: "critical",
      title: "Prototype pollution in left-pad",
      url: "https://example.test/advisories/1",
      range: "<1.3.1",
      fixAvailable: true,
    },
    "minimist": {
      name: "minimist",
      severity: "high",
      title: "Prototype pollution in minimist",
      url: "https://example.test/advisories/2",
      range: "<1.2.6",
      fixAvailable: "1.2.6",
    },
    "yargs-parser": {
      name: "yargs-parser",
      severity: "moderate",
      title: "Prototype pollution in yargs-parser",
      url: null,
      range: "<18.1.2",
      fixAvailable: null,
    },
    "debug": {
      name: "debug",
      severity: "low",
      title: "ReDoS in debug",
      range: "<2.6.9",
    },
    "ms": { name: "ms", severity: "info", title: "Deprecated", range: "<2.1.3" },
  },
  metadata: { vulnerabilities: { info: 1, low: 1, moderate: 1, high: 1, critical: 1 } },
});

// npm 6 advisory shape: { advisories: { id: {...} } }
const NPM6_ADVISORY = JSON.stringify({
  advisories: {
    101: {
      module_name: "serialize-javascript",
      severity: "high",
      title: "Cross-site scripting in serialize-javascript",
      url: "https://example.test/advisories/101",
      vulnerable_versions: "<3.1.0",
    },
    102: {
      module_name: "acorn",
      severity: "low",
      title: "Regular expression denial of service in acorn",
      vulnerable_versions: "<8.0.0",
    },
  },
});

const EMPTY_V7 = JSON.stringify({
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
});

const NPM_ERROR = JSON.stringify({
  error: { code: "ENETUNREACH", summary: "request to registry failed", detail: "network unreachable" },
});

test("parseAuditJson: npm v7 payload → flat records with name/severity/title", () => {
  const { vulnerabilities, source } = parseAuditJson(NPM7_MIXED);
  assert.equal(source, "npm-v7");
  assert.equal(vulnerabilities.length, 5);
  const byName = Object.fromEntries(vulnerabilities.map((v) => [v.name, v]));
  assert.equal(byName["left-pad"].severity, "critical");
  assert.equal(byName["left-pad"].title, "Prototype pollution in left-pad");
  assert.equal(byName["minimist"].url, "https://example.test/advisories/2");
  assert.equal(byName["ms"].severity, "info");
});

test("parseAuditJson: npm v6 advisory payload → mapped to the same shape", () => {
  const { vulnerabilities, source } = parseAuditJson(NPM6_ADVISORY);
  assert.equal(source, "npm-v6");
  assert.equal(vulnerabilities.length, 2);
  const byName = Object.fromEntries(vulnerabilities.map((v) => [v.name, v]));
  assert.equal(byName["serialize-javascript"].severity, "high");
  assert.equal(byName["serialize-javascript"].range, "<3.1.0");
  assert.equal(byName["acorn"].severity, "low");
});

test("parseAuditJson: empty audit → zero vulnerabilities, no error", () => {
  const { vulnerabilities } = parseAuditJson(EMPTY_V7);
  assert.deepEqual(vulnerabilities, []);
});

test("parseAuditJson: malformed JSON throws AuditError", () => {
  assert.throws(() => parseAuditJson("not json {{{"), AuditError);
  assert.throws(() => parseAuditJson(""), AuditError);
  assert.throws(() => parseAuditJson("[1,2,3]"), AuditError);
  assert.throws(() => parseAuditJson("null"), AuditError);
});

test("parseAuditJson: npm error payload throws AuditError mentioning the cause", () => {
  assert.throws(() => parseAuditJson(NPM_ERROR), (err) => {
    assert.ok(err instanceof AuditError);
    assert.match(err.message, /ENETUNREACH/);
    return true;
  });
  // npm's own registry-error JSON shape (e.g. 403 from the audit endpoint).
  const registryError = JSON.stringify({
    message: "403 Forbidden - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - policy_denied",
    method: "POST",
    statusCode: 403,
  });
  assert.throws(() => parseAuditJson(registryError), (err) => {
    assert.ok(err instanceof AuditError);
    assert.match(err.message, /403 Forbidden/);
    return true;
  });
});

test("parseAuditJson: payload with no vulnerabilities section throws", () => {
  assert.throws(() => parseAuditJson(JSON.stringify({ ok: true })), AuditError);
});

test("parseAuditJson: unknown severity throws AuditError", () => {
  const bad = JSON.stringify({ vulnerabilities: { x: { name: "x", severity: "catastrophic" } } });
  assert.throws(() => parseAuditJson(bad), AuditError);
});

test("groupBySeverity: every severity key present, records in severity order", () => {
  const { vulnerabilities } = parseAuditJson(NPM7_MIXED);
  const groups = groupBySeverity(vulnerabilities);
  assert.deepEqual(Object.keys(groups), SEVERITIES);
  assert.deepEqual(groups.critical.map((v) => v.name), ["left-pad"]);
  assert.deepEqual(groups.high.map((v) => v.name), ["minimist"]);
  assert.deepEqual(groups.moderate.map((v) => v.name), ["yargs-parser"]);
  assert.deepEqual(groups.low.map((v) => v.name), ["debug"]);
  assert.deepEqual(groups.info.map((v) => v.name), ["ms"]);
});

test("groupBySeverity: empty input → all empty groups", () => {
  const groups = groupBySeverity([]);
  assert.deepEqual(groups, { info: [], low: [], moderate: [], high: [], critical: [] });
});

test("summarizeAudit: counts, total, and highest severity", () => {
  const { vulnerabilities } = parseAuditJson(NPM7_MIXED);
  const summary = summarizeAudit(vulnerabilities);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.counts, { info: 1, low: 1, moderate: 1, high: 1, critical: 1 });
  assert.equal(summary.highest, "critical");
});

test("summarizeAudit: empty audit → total 0, highest null", () => {
  const { vulnerabilities } = parseAuditJson(EMPTY_V7);
  const summary = summarizeAudit(vulnerabilities);
  assert.equal(summary.total, 0);
  assert.equal(summary.highest, null);
});

test("normalizeThreshold: accepts all severities, rejects junk", () => {
  assert.equal(normalizeThreshold("high"), "high");
  assert.equal(normalizeThreshold("Critical"), "critical");
  assert.equal(normalizeThreshold(undefined), "high");
  assert.throws(() => normalizeThreshold("everything"), AuditError);
});

test("thresholdBreached: breach at threshold and above, pass below", () => {
  const { vulnerabilities } = parseAuditJson(NPM7_MIXED);
  const summary = summarizeAudit(vulnerabilities);
  assert.equal(thresholdBreached(summary, "critical"), true, "critical present → breached at critical");
  assert.equal(thresholdBreached(summary, "high"), true, "critical+high → breached at high");
  assert.equal(thresholdBreached(summary, "info"), true, "anything → breached at info");
  assert.equal(thresholdBreached(summary, "low"), true);
  assert.equal(thresholdBreached(summary, "moderate"), true);
});

test("thresholdBreached: no breach when nothing reaches the threshold", () => {
  const lowOnly = summarizeAudit(parseAuditJson(JSON.stringify({
    vulnerabilities: { ms: { name: "ms", severity: "info" } },
  })).vulnerabilities);
  assert.equal(thresholdBreached(lowOnly, "low"), false);
  assert.equal(thresholdBreached(lowOnly, "critical"), false);
  assert.equal(thresholdBreached(lowOnly, "info"), true, "boundary: equal to threshold breaches");
  const empty = summarizeAudit([]);
  assert.equal(thresholdBreached(empty, "info"), false, "empty audit never breaches");
});

test("renderMarkdown: clean audit shows zero table and a no-vulns note", () => {
  const md = renderMarkdown(summarizeAudit([]));
  assert.match(md, /# Weekly Dependency Audit/);
  assert.match(md, /\*\*Total vulnerabilities:\*\* 0/);
  assert.match(md, /\| critical \| 0 \|/);
  assert.match(md, /No vulnerabilities found/);
});

test("renderMarkdown: findings list severity-descending with names", () => {
  const md = renderMarkdown(summarizeAudit(parseAuditJson(NPM7_MIXED).vulnerabilities));
  assert.match(md, /- \*\*critical\*\* — `left-pad`/);
  assert.match(md, /- \*\*high\*\* — `minimist`/);
  assert.match(md, /\[advisory\]\(https:\/\/example\.test\/advisories\/1\)/);
  assert.match(md, /- \*\*info\*\* — `ms`/);
  assert.ok(md.indexOf("**critical**") < md.indexOf("**high**"), "critical listed before high");
});

test("renderJsonSummary: machine-readable summary carries counts, threshold, verdict", () => {
  const summary = summarizeAudit(parseAuditJson(NPM7_MIXED).vulnerabilities);
  const parsed = JSON.parse(renderJsonSummary(summary, { threshold: "high", breached: true }));
  assert.equal(parsed.tool, "dependency-audit");
  assert.equal(parsed.total, 5);
  assert.equal(parsed.threshold, "high");
  assert.equal(parsed.breached, true);
  assert.equal(parsed.highest, "critical");
  assert.deepEqual(parsed.counts, { info: 1, low: 1, moderate: 1, high: 1, critical: 1 });
  assert.equal(parsed.findings.length, 5);
  assert.ok(parsed.findings.some((f) => f.name === "left-pad" && f.severity === "critical"));
  assert.ok(parsed.generatedAt);
});

test("runAudit: injected runner wires parse → summarize → verdict", async () => {
  const runner = async () => NPM7_MIXED;
  const result = await runAudit({ runner, threshold: "high" });
  assert.equal(result.summary.total, 5);
  assert.equal(result.threshold, "high");
  assert.equal(result.breached, true);
  const clean = await runAudit({ runner: async () => EMPTY_V7, threshold: "high" });
  assert.equal(clean.summary.total, 0);
  assert.equal(clean.breached, false);
});

test("runAudit: runner that returns malformed JSON propagates AuditError", async () => {
  await assert.rejects(runAudit({ runner: async () => "garbage {" }), AuditError);
});

test("runAudit: runner that rejects propagates its error", async () => {
  await assert.rejects(runAudit({ runner: async () => { throw new Error("spawn ENOENT"); } }), /spawn ENOENT/);
});

test("runAudit: default threshold is high", async () => {
  const lowOnly = JSON.stringify({ vulnerabilities: { ms: { name: "ms", severity: "low" } } });
  const result = await runAudit({ runner: async () => lowOnly });
  assert.equal(result.threshold, "high");
  assert.equal(result.breached, false);
});

test("parseArgs: flags parsed, unknown flags rejected", () => {
  assert.deepEqual(parseArgs(["--fail-on=critical", "--out=a.md", "--json-out=b.json"]), {
    failOn: "critical", out: "a.md", jsonOut: "b.json", help: false,
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs([]).failOn, "high");
  assert.throws(() => parseArgs(["--nuke"]), AuditError);
});
