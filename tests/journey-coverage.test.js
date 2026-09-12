import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCoverageMap, checkCoverage, parseBrowserSuite } from "../scripts/journey-coverage.mjs";

const markdown = readFileSync(new URL("../docs/JOURNEY-COVERAGE-MAP.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("coverage map parses and every claimed capability has wired executable evidence", () => {
  const map = parseCoverageMap(markdown);
  assert.ok(map.claims.length >= 7, "the README capability claims are all mapped");
  const problems = checkCoverage(map, { browserSuite: parseBrowserSuite(pkg.scripts["test:browser"]) });
  assert.deepEqual(problems, []);
});

test("a claim with no unit or browser evidence is an untested user path", () => {
  const map = { version: 1, claims: [{ id: "x", claim: "c", evidence: { unit: [], browser: [] } }] };
  const problems = checkCoverage(map, { exists: () => true });
  assert.ok(problems.some(p => /untested user path/.test(p)));
});

test("missing files and unwired browser checks fail closed", () => {
  const map = {
    version: 1,
    claims: [{
      id: "x",
      claim: "c",
      evidence: {
        unit: ["tests/definitely-missing.test.js"],
        browser: ["scripts/definitely-missing-check.mjs"],
        agent: ["docs/DEFINITELY-MISSING.md"],
        hosted: [],
      },
    }],
  };
  const problems = checkCoverage(map, { exists: () => false, browserSuite: [] });
  assert.ok(problems.some(p => /unit evidence tests\/definitely-missing\.test\.js does not exist/.test(p)));
  assert.ok(problems.some(p => /browser evidence scripts\/definitely-missing-check\.mjs does not exist/.test(p)));
  assert.ok(problems.some(p => /evidence docs\/DEFINITELY-MISSING\.md does not exist/.test(p)));
  const unwired = checkCoverage(map, { exists: () => true, browserSuite: ["scripts/other-check.mjs"] });
  assert.ok(unwired.some(p => /not wired into npm run test:browser/.test(p)));
});

test("malformed maps fail loudly instead of passing vacuously", () => {
  assert.throws(() => parseCoverageMap("no block here"), /coverage-map block/);
  assert.throws(() => parseCoverageMap("```json coverage-map\n{\"version\":1,\"claims\":[]}\n```"), /at least one claim/);
  const problems = checkCoverage({ version: 1, claims: [{ id: "x", claim: "c" }, { id: "x", claim: "c2" }] }, { exists: () => true });
  assert.ok(problems.some(p => /no unit or browser evidence/.test(p)));
  assert.ok(problems.some(p => /duplicate claim id/.test(p)));
});

test("browser suite membership is exact, not substring: check.mjs is not other-check.mjs", () => {
  assert.deepEqual(parseBrowserSuite("node --test scripts/other-check.mjs"), ["scripts/other-check.mjs"]);
  assert.deepEqual(parseBrowserSuite(undefined), []);
  const map = { version: 1, claims: [{ id: "x", claim: "c",
    evidence: { unit: [], browser: ["scripts/check.mjs"] } }] };
  const problems = checkCoverage(map, { exists: () => true, browserSuite: parseBrowserSuite("node --test scripts/other-check.mjs") });
  assert.ok(problems.some(p => /not wired into npm run test:browser/.test(p)),
    "substring match must not count as wired");
  // a non-array suite fails closed instead of throwing or substring-matching
  const closed = checkCoverage(map, { exists: () => true, browserSuite: "node --test scripts/check.mjs" });
  assert.ok(closed.some(p => /not wired into npm run test:browser/.test(p)));
});
