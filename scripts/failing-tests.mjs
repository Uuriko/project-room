#!/usr/bin/env node
/**
 * scripts/failing-tests.mjs
 *
 * CI honesty: turn `node --test` output into a short list of failing test
 * names, so the "Report failures to PR" step names the failures instead of
 * pointing at the job log. Pure functions, zero dependencies.
 *
 * node --test uses the spec reporter by default (Node 24): failures print as
 * `✖ <name> (<duration>ms)`. TAP `not ok` lines are accepted as a fallback
 * (e.g. `--test-reporter=tap`).
 */

/** Max failing test names carried in a shard receipt / PR comment. */
export const MAX_FAILURES = 20;

const TAP_NOT_OK = /^\s*not ok \d+ - (.*)$/;
const SPEC_FAIL = /^\s*✖ (.+?) \([\d.]+ms\)$/u;

/**
 * Extract failing test names from `node --test` stdout.
 * Matches spec-reporter `✖` lines (top-level and indented nested) and TAP
 * `not ok` lines, dedupes repeats, caps at MAX_FAILURES. Returns [] for
 * empty/missing input.
 */
export function parseFailingTests(output) {
  if (typeof output !== "string" || output.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const line of output.split("\n")) {
    const m = SPEC_FAIL.exec(line) ?? TAP_NOT_OK.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_FAILURES) break;
  }
  return out;
}

/**
 * Compose the PR comment body for a failed unit shard. When no failure names
 * were captured, falls back to the old "see the job log" pointer so the
 * comment never goes out empty.
 */
export function formatFailureComment({ shard, total, failures, runUrl }) {
  const head = `## Unit test failures, shard ${shard}/${total}\n`;
  if (!Array.isArray(failures) || failures.length === 0) {
    return (
      `${head}\nSee the job log for the failing file and assertion. Shard receipts\n` +
      `are in the unit-shard-evidence artifact.\n`
    );
  }
  const list = failures.map((f) => `- ${f}`).join("\n");
  const link = runUrl ? `\n\nRun: ${runUrl}` : "";
  return (
    `${head}\nFailing tests:\n\n${list}\n\n` +
    `Shard receipts are in the unit-shard-evidence artifact.${link}\n`
  );
}
