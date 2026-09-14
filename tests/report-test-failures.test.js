import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  MAX_FAILURES, MAX_MESSAGE, annotation, decodeXml, parseJunit, report, summaryMarkdown,
} from "../scripts/report-test-failures.mjs";
import { RESULTS_FILE, ciArgs } from "../scripts/browser-ci.mjs";

const FIXTURE = "tests/fixtures/browser-junit-sample.xml";
const RUNNER_CWD = "/home/runner/work/project-room/project-room";
const xml = readFileSync(FIXTURE, "utf8");

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "report-test-failures-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseJunit reads one pass, two failures and one skip from the fixture", () => {
  const { cases, totals } = parseJunit(xml, { cwd: RUNNER_CWD });
  assert.deepEqual(cases.map(c => c.status), ["passed", "failed", "failed", "skipped"]);
  assert.deepEqual(totals, { tests: 4, pass: 1, fail: 2, cancelled: 0, skipped: 1, todo: 0, duration_ms: 9312.4 });
  const [, assertion, timeout, skipped] = cases;
  assert.equal(assertion.suite, "inbox-browser-check.mjs");
  assert.equal(assertion.file, "scripts/inbox-browser-check.mjs");
  assert.equal(assertion.name, "inbox › marks a thread read: 100% of rows, no dupes");
  assert.equal(assertion.message, "Expected values to be strictly equal:");
  assert.equal(assertion.seconds, 0.987125);
  assert.equal(timeout.message, "locator.click: Timeout 30000ms exceeded.");
  assert.equal(timeout.seconds, 30.0413);
  assert.equal(skipped.name, 'inbox › quiet mode "a | b"', "Node double-escapes quotes in attributes");
});

test("a file path outside the working directory stays absolute and gets no file= property", () => {
  const { cases } = parseJunit(xml, { cwd: "/somewhere/else" });
  assert.equal(cases[1].file, `${RUNNER_CWD}/scripts/inbox-browser-check.mjs`);
  assert.equal(cases[1].suite, "inbox-browser-check.mjs");
  assert.match(annotation(cases[1]), /^::error title=inbox-browser-check\.mjs::/);
});

test("annotations follow the workflow-command grammar with escaped properties", () => {
  const { failures, annotations } = report(xml, { cwd: RUNNER_CWD });
  assert.equal(failures.length, 2);
  assert.deepEqual(annotations, [
    "::error file=scripts/inbox-browser-check.mjs,title=inbox-browser-check.mjs::inbox › marks a thread read: 100%25 of rows, no dupes: Expected values to be strictly equal:",
    "::error file=scripts/inbox-browser-check.mjs,title=inbox-browser-check.mjs::inbox › reconnects after the server restarts: locator.click: Timeout 30000ms exceeded.",
  ]);
  const tricky = annotation({ suite: "a:b,c.mjs", file: "scripts/a:b,c.mjs", name: "line1\nline2", message: "50%\r\n", seconds: 1 });
  assert.equal(tricky, "::error file=scripts/a%3Ab%2Cc.mjs,title=a%3Ab%2Cc.mjs::line1%0Aline2: 50%25%0D%0A");
});

test("the job summary is a Markdown table with suite, test, first error line and duration", () => {
  const { summary } = report(xml, { cwd: RUNNER_CWD });
  assert.equal(summary, [
    "### Browser tests: 2 failed of 4, 1 skipped",
    "",
    "| Suite | Test | First error line | Duration |",
    "| --- | --- | --- | --- |",
    "| `inbox-browser-check.mjs` | inbox › marks a thread read: 100% of rows, no dupes | Expected values to be strictly equal: | 987 ms |",
    "| `inbox-browser-check.mjs` | inbox › reconnects after the server restarts | locator.click: Timeout 30000ms exceeded. | 30.0 s |",
    "",
  ].join("\n"));
  assert.equal(summaryMarkdown([], { pass: 40, skipped: 2 }), "**Browser tests:** 40 passed, 2 skipped, 0 failed.\n");
  const piped = summaryMarkdown([{ suite: "s.mjs", name: "a | b", message: "x | y", seconds: 0.5 }], { tests: 1 });
  assert.match(piped, /\| a \\\| b \| x \\\| y \| 500 ms \|/);
  const html = summaryMarkdown([{ suite: "s.mjs", name: "<Inbox> & co", message: "no <button>", seconds: 2 }], { tests: 1 });
  assert.match(html, /\| &lt;Inbox> &amp; co \| no &lt;button> \| 2\.0 s \|/);
});

test("output is capped at MAX_FAILURES entries and MAX_MESSAGE characters", () => {
  const cases = Array.from({ length: MAX_FAILURES + 10 }, (_, i) =>
    `<testcase name="t${i}" time="0.1" classname="test" file="/r/scripts/x-check.mjs"><failure type="testCodeFailure" message="${"m".repeat(900)}">body</failure></testcase>`);
  const { failures, annotations, summary } = report(`<testsuites>${cases.join("")}</testsuites>`, { cwd: "/r" });
  assert.equal(failures.length, MAX_FAILURES + 10);
  assert.equal(annotations.length, MAX_FAILURES + 1);
  assert.equal(annotations.filter(a => a.startsWith("::error ")).length, MAX_FAILURES);
  assert.match(annotations.at(-1), /^::warning title=browser tests::10 more failures not annotated/);
  const message = annotations[0].split(":: ").pop().split(": ").pop();
  assert.equal(message.length, MAX_MESSAGE);
  assert.ok(message.endsWith("…"));
  assert.equal(summary.split("\n").filter(l => l.startsWith("| `")).length, MAX_FAILURES);
  assert.match(summary, /…and 10 more\. Full results: `test-results\/browser-junit\.xml`/);
});

test("a crashed suite process reports its exit code; a truncated file warns instead of throwing", () => {
  const crashed = `<testsuites><testcase name="inbox-browser-check.mjs" time="95.3" classname="test" file="/r/scripts/inbox-browser-check.mjs" failure="test failed">
    <failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: null, signal: 'SIGKILL' }
    </failure></testcase></testsuites>`;
  const { failures } = report(crashed, { cwd: "/r" });
  assert.equal(failures[0].message, "test failed (signal SIGKILL)");
  const { annotations, summary } = report("<?xml version=\"1.0\"?><testsuites>", {});
  assert.deepEqual(annotations, ["::warning title=browser tests::no test cases found in test-results/browser-junit.xml; the run may have died before node --test wrote results"]);
  assert.equal(summary, "**Browser tests:** 0 passed, 0 failed.\n");
  assert.equal(decodeXml("&lt;a&gt; &amp; &#10;&#x41;&amp;quot;"), '<a> & \nA"');
});

test("the CLI prints annotations, appends to $GITHUB_STEP_SUMMARY and exits 0; a missing file only warns", (t) => {
  const dir = tmp(t);
  const summaryPath = join(dir, "summary.md");
  writeFileSync(summaryPath, "# earlier step\n");
  const run = spawnSync(process.execPath, ["scripts/report-test-failures.mjs", FIXTURE], {
    encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.filter(l => l.startsWith("::error ")).length, 2);
  assert.match(lines.at(-1), /^report-test-failures: 2 failed, 1 passed, 1 skipped/);
  assert.match(readFileSync(summaryPath, "utf8"), /^# earlier step\n### Browser tests: 2 failed of 4, 1 skipped\n/);

  const missing = spawnSync(process.execPath, ["scripts/report-test-failures.mjs", join(dir, "nope.xml")], { encoding: "utf8" });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^::warning title=browser tests::no results file at /);
});

test("test:browser:ci runs the test:browser suite list with spec + junit reporters", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["test:browser:ci"], "node scripts/browser-ci.mjs");
  const args = ciArgs(pkg.scripts["test:browser"]);
  const files = pkg.scripts["test:browser"].match(/scripts\/[\w.-]+\.mjs/g);
  assert.deepEqual(args.slice(0, 8), [
    "--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=junit", `--test-reporter-destination=${RESULTS_FILE}`,
    "--test-reporter=./scripts/browser-ci-reporter.mjs", "--test-reporter-destination=stdout", "--test-concurrency=1",
  ]);
  assert.deepEqual(args.slice(8), files, "every suite wired into test:browser runs in CI too");
  assert.equal(RESULTS_FILE, "test-results/browser-junit.xml", "lives where upload-artifact already looks");
  assert.throws(() => ciArgs("playwright test"), /must start with "node --test"/);
  assert.throws(() => ciArgs("node --test --test-reporter=tap a.mjs"), /already sets --test-reporter/);
});

test("the browser job runs test:browser:ci and always reports failures before uploading evidence", () => {
  const workflow = readFileSync(".github/workflows/test.yml", "utf8");
  const browser = workflow.slice(workflow.indexOf("\n  browser:"), workflow.indexOf("\n  cloudflare:"));
  const order = ["run: npm run test:browser:ci", "if: always()", `run: node scripts/report-test-failures.mjs ${RESULTS_FILE}`, "uses: actions/upload-artifact@v4"]
    .map(needle => browser.indexOf(needle));
  assert.ok(order.every(i => i >= 0), `browser job is missing a step: ${JSON.stringify(order)}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps run in order: tests, report, upload");
  assert.ok(!browser.includes("run: npm run test:browser\n"), "CI uses the reporter-equipped variant");
});
