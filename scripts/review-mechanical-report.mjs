// Renders the review-mechanical check report: a short human table plus a
// machine-readable JSON block marked with <!-- review-mechanical-report -->.
// The workflow prints the returned markdown into $GITHUB_STEP_SUMMARY.
// renderReport() is pure and unit-tested; the JSON shape is the contract
// that reviewers and tooling read.
//
// Usage:
//   node scripts/review-mechanical-report.mjs --stage fast|full --pr <n> \
//     --head <sha> --lint <conclusion> --tests <conclusion> \
//     --additions <n> --deletions <n> --scope-json <path>
//   node scripts/review-mechanical-report.mjs --annotations --scope-json <path>
//     (prints properly-escaped ::warning annotations for scope drift)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// GitHub workflow-command escaping (docs.github.com/en/actions/reference/workflows/commands-for-github-actions):
// data escapes %, CR, LF; property values additionally escape : and ,.
// The % replacement runs first so later insertions are not re-escaped.
export function escapeCommandData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeCommandProperty(s) {
  return escapeCommandData(s).replace(/:/g, "%3A").replace(/,/g, "%3B");
}

// Scope-drift annotations for the workflow log. File paths are interpolated
// into the `file=` property, so they must be property-escaped; the message
// is data-escaped. A raw path containing : or , would corrupt the annotation.
export function driftAnnotations(scope) {
  return (scope.drift ?? []).map(
    f => `::warning file=${escapeCommandProperty(f)}::${escapeCommandData(`Scope drift: ${f} is not in the declared claim files`)}`,
  );
}

export function renderReport({ stage, pr, head, lint, tests, additions, deletions, scope }) {
  const report = {
    check: "review-mechanical",
    stage,
    pr: Number(pr),
    head,
    lint,
    tests,
    files_changed: scope.changedCount,
    lines_added: Number(additions),
    lines_deleted: Number(deletions),
    scope: {
      verdict: scope.verdict,
      drift: scope.drift,
      declared: scope.declared,
    },
    generated_at: new Date().toISOString(),
  };
  const driftLine =
    report.scope.verdict === "drift"
      ? `⚠️ **scope drift**: ${report.scope.drift.join(", ")} — reviewer acknowledges`
      : report.scope.verdict === "undeclared"
        ? "ℹ️ no `claim-files` declared in the PR body — reviewer checks scope by hand"
        : "✅ diff stays inside the declared claim files";
  const markdown =
    `## review-mechanical report\n\n` +
    `| signal | result |\n|---|---|\n` +
    `| lint | ${report.lint} |\n` +
    `| tests | ${report.tests} |\n` +
    `| files changed | ${report.files_changed} |\n` +
    `| lines + / − | ${report.lines_added} / ${report.lines_deleted} |\n` +
    `| claim scope | ${report.scope.verdict} |\n\n${driftLine}\n\n` +
    `<!-- review-mechanical-report -->\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  return { report, markdown };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = JSON.parse(readFileSync(resolve(root, args["scope-json"]), "utf8"));
  if (args.annotations) {
    for (const line of driftAnnotations(scope)) process.stdout.write(line + "\n");
    return;
  }
  const { markdown } = renderReport({
    stage: args.stage,
    pr: args.pr,
    head: args.head,
    lint: args.lint,
    tests: args.tests,
    additions: args.additions,
    deletions: args.deletions,
    scope,
  });
  process.stdout.write(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
