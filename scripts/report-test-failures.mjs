// Turn a `node --test --test-reporter=junit` results file into GitHub
// Actions annotations and a job summary (BUILD-01 task B50).
//
//   node scripts/report-test-failures.mjs [test-results/browser-junit.xml]
//
// Per failed test it prints one `::error title=<suite>::<test>: <first line
// of the failure>` command (readable via the check-runs annotations API) and,
// when $GITHUB_STEP_SUMMARY is set, appends a Markdown table (suite, test,
// first error line, duration) to it (readable via the job summary API).
// Output is capped: MAX_FAILURES rows/annotations, MAX_MESSAGE chars each.
//
// Exit status is 0 whenever the file was read, including a missing file
// (a `::warning` is emitted instead): this step runs `if: always()` after
// the test step, which already decided the job's colour. A genuine bug in
// this script still throws so it cannot silently rot.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { RESULTS_FILE } from "./browser-ci.mjs";

export const MAX_FAILURES = 50;
export const MAX_MESSAGE = 500;

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(text) {
  const once = String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // Node's junit reporter double-escapes quotes in attributes ("&amp;quot;").
  return once.replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Attribute values are always double-quoted and never contain a raw `"`, but
// they may contain a raw `>`, so tags cannot be matched with [^>]*.
const ATTRS = String.raw`((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>`;
const TESTCASE = new RegExp(String.raw`<testcase\b` + ATTRS, "g");
const FAILURE = new RegExp(String.raw`<(failure|error)\b` + ATTRS);

function attributes(text) {
  const out = {};
  for (const m of String(text).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? "";
}

function displayPath(file, cwd) {
  if (!file) return "";
  if (!isAbsolute(file)) return file;
  const rel = relative(cwd, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

// Returns { cases: [{ status, suite, file, name, message, seconds }], totals }.
export function parseJunit(xml, { cwd = process.cwd() } = {}) {
  const text = String(xml ?? "");
  const cases = [];
  TESTCASE.lastIndex = 0;
  let m;
  while ((m = TESTCASE.exec(text))) {
    const attrs = attributes(m[1]);
    let body = "";
    if (!m[2]) {
      const end = text.indexOf("</testcase>", TESTCASE.lastIndex);
      body = text.slice(TESTCASE.lastIndex, end === -1 ? undefined : end);
      if (end !== -1) TESTCASE.lastIndex = end + "</testcase>".length;
    }
    const file = displayPath(attrs.file, cwd);
    const classname = attrs.classname && attrs.classname !== "test" ? attrs.classname : "";
    const suite = basename(file) || classname || "(unknown suite)";
    const name = classname && classname !== suite ? `${classname} › ${attrs.name ?? ""}` : (attrs.name ?? "");
    const seconds = Number(attrs.time);
    const entry = { status: "passed", suite, file, name, message: "", seconds: Number.isFinite(seconds) ? seconds : 0 };
    const failure = FAILURE.exec(body);
    if (failure) {
      const fattrs = attributes(failure[2]);
      let message = firstLine(fattrs.message) || firstLine(attrs.failure) || firstLine(decodeXml(body.replace(FAILURE, "")));
      // A suite process that died before finishing is reported as a bare
      // "test failed"; the exit code / signal is only in the element body.
      const exit = /exitCode:\s*(\w+),\s*signal:\s*'?(\w+)'?/.exec(body);
      if (exit && message === "test failed") {
        message += exit[2] !== "null" ? ` (signal ${exit[2]})` : ` (suite process exited with code ${exit[1]})`;
      }
      entry.status = "failed";
      entry.message = message || failure[1];
    } else if (/<skipped\b/.test(body)) {
      entry.status = "skipped";
    }
    cases.push(entry);
  }
  const totals = {};
  for (const c of text.matchAll(/<!--\s*(tests|pass|fail|skipped|cancelled|todo|duration_ms)\s+([\d.]+)\s*-->/g)) totals[c[1]] = Number(c[2]);
  if (totals.tests === undefined) {
    totals.tests = cases.length;
    totals.pass = cases.filter(c => c.status === "passed").length;
    totals.fail = cases.filter(c => c.status === "failed").length;
    totals.skipped = cases.filter(c => c.status === "skipped").length;
  }
  return { cases, totals };
}

// Workflow-command escaping: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = s => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = s => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function clip(text, max = MAX_MESSAGE) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  return seconds >= 1 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds * 1000)} ms`;
}

export function annotation(failure) {
  const props = [];
  if (failure.file && !isAbsolute(failure.file) && !failure.file.startsWith("..")) props.push(`file=${escapeProperty(failure.file)}`);
  props.push(`title=${escapeProperty(clip(failure.suite, 200))}`);
  return `::error ${props.join(",")}::${escapeData(`${clip(failure.name, 200)}: ${clip(failure.message)}`)}`;
}

// Cells are Markdown: escape pipes, and `<`/`&` so a "<button>" in a message is not eaten as HTML.
const cell = s => clip(String(s ?? "")).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function summaryMarkdown(failures, totals, { resultsFile = RESULTS_FILE, max = MAX_FAILURES } = {}) {
  const skipped = totals.skipped ? `, ${totals.skipped} skipped` : "";
  if (failures.length === 0) {
    return `**Browser tests:** ${totals.pass ?? 0} passed${skipped}, 0 failed.\n`;
  }
  const lines = [
    `### Browser tests: ${failures.length} failed of ${totals.tests ?? failures.length}${skipped}`,
    "",
    "| Suite | Test | First error line | Duration |",
    "| --- | --- | --- | --- |",
    ...failures.slice(0, max).map(f => `| \`${cell(f.suite)}\` | ${cell(f.name)} | ${cell(f.message)} | ${formatDuration(f.seconds)} |`),
  ];
  if (failures.length > max) lines.push("", `…and ${failures.length - max} more. Full results: \`${resultsFile}\` in the job's evidence artifact.`);
  return lines.join("\n") + "\n";
}

export function report(xml, options = {}) {
  const { cases, totals } = parseJunit(xml, options);
  const failures = cases.filter(c => c.status === "failed");
  const annotations = failures.slice(0, options.max ?? MAX_FAILURES).map(annotation);
  if (failures.length > annotations.length) {
    annotations.push(`::warning title=browser tests::${escapeData(`${failures.length - annotations.length} more failures not annotated; see ${options.resultsFile ?? RESULTS_FILE} in the evidence artifact`)}`);
  }
  if (cases.length === 0) {
    annotations.push(`::warning title=browser tests::${escapeData(`no test cases found in ${options.resultsFile ?? RESULTS_FILE}; the run may have died before node --test wrote results`)}`);
  }
  return { cases, totals, failures, annotations, summary: summaryMarkdown(failures, totals, options) };
}

function main() {
  const resultsFile = process.argv[2] || RESULTS_FILE;
  if (!existsSync(resultsFile)) {
    console.log(`::warning title=browser tests::${escapeData(`no results file at ${resultsFile}; the run may have died before node --test wrote it`)}`);
    return;
  }
  const result = report(readFileSync(resultsFile, "utf8"), { resultsFile });
  for (const line of result.annotations) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
  else process.stdout.write(result.summary);
  console.log(`report-test-failures: ${result.failures.length} failed, ${result.totals.pass ?? 0} passed, ${result.totals.skipped ?? 0} skipped (${resultsFile})`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
