// Publishes the weekly onboarding-probe results table into a docs-committed
// file, newest run first. The weekly `onboarding-probe` CI job runs this
// after run.mjs so the measured zero-to-first-claim times per path are
// visible from the repo, not only in the CI job summary.
// Additive: it never touches probe-out or the job summary, only docs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ANCHOR = "<!-- onboarding-probe-runs: newest first -->";

export function fileHeader() {
  return [
    "# Onboarding probe — weekly results",
    "",
    "Newest run first. The weekly `onboarding-probe` CI job writes each run's",
    "table here from `probe-out/table.md`, with the run metadata from",
    "`probe-out/probe-result.json`. The 4-week median column compares against",
    "[baseline.json](baseline.json), which changes only by pull request.",
    "",
    ANCHOR,
    "",
  ].join("\n");
}

function runDate(runAt) {
  return String(runAt ?? "").slice(0, 10) || "unknown date";
}

function ciLine({ runId, runUrl }) {
  if (!runId) return "";
  const label = `CI run ${runId}`;
  return runUrl ? `[${label}](${runUrl})` : label;
}

export function renderRunSection({ result, table, mode, runId, runUrl }) {
  const runAt = result?.runAt ?? null;
  const target = result?.target ?? "unknown target";
  const sourceRevision = result?.sourceRevision ?? "unknown";
  const meta = [
    `## ${runDate(runAt)} — ${mode ?? "production"}`,
    "",
    `- Ran ${runAt ?? "unknown time"} · target \`${target}\` · source revision \`${sourceRevision}\``,
  ];
  const ci = ciLine({ runId, runUrl });
  if (ci) meta.push(`- ${ci}`);
  meta.push("", String(table ?? "").replace(/\s+$/, ""), "");
  return `${meta.join("\n")}\n`;
}

export function publishRunSection(docsPath, section) {
  mkdirSync(dirname(docsPath), { recursive: true });
  let current = null;
  try {
    current = readFileSync(docsPath, "utf8");
  } catch {
    current = null;
  }
  const body = `${String(section).replace(/\s+$/, "")}\n`;
  if (!current || !current.includes(ANCHOR)) {
    writeFileSync(docsPath, `${fileHeader()}\n${body}`);
    return;
  }
  writeFileSync(docsPath, current.replace(ANCHOR, `${ANCHOR}\n\n${body}`));
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invoked = process.argv[1]?.endsWith("docs-publish.mjs");
if (invoked) {
  const resultFile = arg("--result");
  const tableFile = arg("--table");
  const docsPath = arg("--docs");
  const runId = arg("--run-id");
  const runUrl = arg("--run-url");
  let mode = arg("--mode");
  if (!resultFile || !tableFile || !docsPath) {
    console.error("usage: node docs-publish.mjs --result probe-out/probe-result.json --table probe-out/table.md --docs docs/onboarding-probe/results.md [--mode production|staging] [--run-id id] [--run-url url]");
    process.exit(2);
  }
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch (error) {
    console.error(`cannot read result: ${resultFile} (${error.message})`);
    process.exit(1);
  }
  let table;
  try {
    table = readFileSync(tableFile, "utf8");
  } catch (error) {
    console.error(`cannot read table: ${tableFile} (${error.message})`);
    process.exit(1);
  }
  if (!mode) {
    mode = String(result.target ?? "").includes("trydemigod") ? "production" : "staging";
  }
  publishRunSection(docsPath, renderRunSection({ result, table, mode, runId, runUrl }));
  console.log(`published onboarding probe results to ${docsPath}`);
}
