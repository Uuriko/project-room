// Shared axe-core runner for the Q011 accessibility browser checks.
//
// One axe configuration for every check, so a violation that appears in one
// flow and disappears in another is a page difference, not a config drift:
//   - tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa (same set the
//     existing board/public-pages checks use)
//   - fail signal: serious or critical impact violations only. Minor/moderate
//     findings are surfaced in the failure detail for triage but do not fail,
//     so the suite stays a regression gate rather than a style debate.
//
// The checks assert a clean page. When a check fails, the thrown message
// lists every serious/critical violation with its help text and the first
// few offending selectors, so the owning lane can fix it without re-running.
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";

export const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Chromium launch options shared by the a11y checks. Honors the same
// ROOM_TEST_CHROMIUM_PATH override the other browser checks use.
export function chromiumLaunchOptions() {
  return {
    headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}),
  };
}

// Run axe against the page and return the serious/critical violations in a
// small printable shape. `include`/`exclude` scope the run to a region
// (e.g. only the composer) without changing the rule set.
export async function axeSerious(page, { include = [], exclude = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  for (const selector of include) builder = builder.include(selector);
  for (const selector of exclude) builder = builder.exclude(selector);
  const result = await builder.analyze();
  const other = result.violations.filter(item => item.impact !== "serious" && item.impact !== "critical");
  const serious = result.violations
    .filter(item => item.impact === "serious" || item.impact === "critical")
    .map(item => ({
      id: item.id,
      impact: item.impact,
      help: item.help,
      helpUrl: item.helpUrl,
      targets: item.nodes.slice(0, 5).map(node => node.target.join(" ")),
      nodeCount: item.nodes.length,
    }));
  return { serious, other: other.map(item => `${item.impact} ${item.id} (${item.nodes.length} nodes)`) };
}

// Fail the test when any serious/critical violation is present. The detail
// lists every violation with help text and selectors for the owning lane.
export function assertAxeClean({ serious, other }, label) {
  const detail = serious
    .map(item => `  [${item.impact}] ${item.id} — ${item.help}\n    ${item.targets.join("\n    ")}${item.nodeCount > item.targets.length ? `\n    … +${item.nodeCount - item.targets.length} more nodes` : ""}\n    ${item.helpUrl}`)
    .join("\n");
  const minor = other.length ? `\nNon-failing (minor/moderate) findings for triage: ${other.join("; ")}` : "";
  assert.deepEqual(
    serious.map(item => `${item.impact} ${item.id}`),
    [],
    `${label}: axe-core found serious/critical violations:\n${detail}${minor}`,
  );
}
