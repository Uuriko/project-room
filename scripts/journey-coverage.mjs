// Journey coverage map (M1): every claimed capability links to executable
// evidence, so a bare test count cannot conceal an untested user path.
// The map lives in docs/JOURNEY-COVERAGE-MAP.md as a fenced
// ```json coverage-map block; this checker fails on any claim with no
// unit/browser evidence, any linked file that does not exist, and any
// browser check that is not wired into npm run test:browser.
import { existsSync, readFileSync } from "node:fs";

export function parseCoverageMap(markdown) {
  const m = /```json coverage-map\n([\s\S]*?)\n```/.exec(String(markdown));
  if (!m) throw new Error("JOURNEY-COVERAGE-MAP.md has no ```json coverage-map block");
  const map = JSON.parse(m[1]);
  if (map.version !== 1 || !Array.isArray(map.claims) || map.claims.length === 0) {
    throw new Error("coverage map must be { version: 1, claims: [...] } with at least one claim");
  }
  return map;
}

// Extract wired script paths from an npm script string. checkCoverage takes an
// array and tests exact membership: the old string form allowed substring
// false-negatives ("scripts/check.mjs" matching "scripts/other-check.mjs").
export function parseBrowserSuite(script) {
  return [...new Set(String(script || "").match(/scripts\/[A-Za-z0-9_.-]+\.mjs/g) ?? [])];
}

export function checkCoverage(map, { exists = existsSync, browserSuite = [] } = {}) {
  const wired = Array.isArray(browserSuite) ? browserSuite : [];
  const problems = [];
  const seen = new Set();
  for (const claim of map.claims) {
    const label = claim && claim.id ? claim.id : "(no id)";
    if (!claim || typeof claim.id !== "string" || !claim.id) problems.push("claim missing id");
    if (!claim || typeof claim.claim !== "string" || !claim.claim) problems.push(`${label}: missing claim text`);
    if (claim?.id) { if (seen.has(claim.id)) problems.push(`${label}: duplicate claim id`); seen.add(claim.id); }
    const ev = claim?.evidence && typeof claim.evidence === "object" ? claim.evidence : {};
    const unit = Array.isArray(ev.unit) ? ev.unit : [];
    const browser = Array.isArray(ev.browser) ? ev.browser : [];
    const agent = Array.isArray(ev.agent) ? ev.agent : [];
    const hosted = Array.isArray(ev.hosted) ? ev.hosted : [];
    if (unit.length === 0 && browser.length === 0) {
      problems.push(`${label}: no unit or browser evidence - untested user path`);
    }
    for (const path of unit) {
      if (!/^tests\/.+\.test\.js$/.test(path)) problems.push(`${label}: unit evidence ${path} is not a tests/*.test.js path`);
      else if (!exists(path)) problems.push(`${label}: unit evidence ${path} does not exist`);
    }
    for (const path of browser) {
      if (!/^scripts\/.+\.mjs$/.test(path)) problems.push(`${label}: browser evidence ${path} is not a scripts/*.mjs path`);
      else if (!exists(path)) problems.push(`${label}: browser evidence ${path} does not exist`);
      else if (!wired.includes(path)) problems.push(`${label}: browser evidence ${path} is not wired into npm run test:browser`);
    }
    for (const path of [...agent, ...hosted]) {
      if (!exists(path)) problems.push(`${label}: evidence ${path} does not exist`);
    }
  }
  return problems;
}

function main() {
  const map = parseCoverageMap(readFileSync("docs/JOURNEY-COVERAGE-MAP.md", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const problems = checkCoverage(map, { browserSuite: parseBrowserSuite(pkg.scripts?.["test:browser"]) });
  if (problems.length) {
    for (const p of problems) console.error(`journey-coverage: ${p}`);
    process.exit(1);
  }
  console.log(`journey-coverage: ${map.claims.length} claimed capabilities, every one linked to executable evidence`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
