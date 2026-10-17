import test from "node:test";
import assert from "node:assert/strict";
import { relatedTests, resolveSpecifier, buildReverseGraph } from "../scripts/verify-affected.mjs";

const nfc = "server/café.mjs";
const nfd = "server/café.mjs";

test("an NFC changed path still finds importers recorded under the NFD spelling", () => {
  assert.notEqual(nfc, nfd);
  // Git tracks filenames as bytes, so both spellings of one file can coexist
  // in `known` (e.g. an NFD name committed from one checkout next to NFC).
  const reverse = new Map([
    [nfc, new Set(["tests/a.test.js"])],
    [nfd, new Set(["tests/b.test.js"])],
  ]);
  const tests = ["tests/a.test.js", "tests/b.test.js"];
  const read = () => "";

  const viaNfc = relatedTests({ changed: [nfc], tests, reverse, read });
  assert.deepEqual(
    [...viaNfc.keys()].sort(),
    ["tests/a.test.js", "tests/b.test.js"],
    "NFC change must select importers under both spellings, like the NFD change does",
  );

  const viaNfd = relatedTests({ changed: [nfd], tests, reverse, read });
  assert.deepEqual(
    [...viaNfd.keys()].sort(),
    ["tests/a.test.js", "tests/b.test.js"],
    "NFD change selects importers under both spellings (symmetry check)",
  );
});

test("resolveSpecifier reuses one composed index per known set", () => {
  // Regression guard for the per-call index rebuild: resolving many
  // specifiers against a large `known` set must stay near the cost of one
  // pass over `known`, not one pass per call.
  const files = [];
  for (let i = 0; i < 1500; i++) files.push(`server/mod${i}.mjs`);
  const known = new Set(files);
  const read = (f) => {
    const i = Number(f.match(/\d+/)[0]);
    let src = "";
    for (let k = 1; k <= 4; k++) src += `import x from "./mod${(i + k) % 1500}.mjs";\n`;
    return src;
  };
  const started = Date.now();
  buildReverseGraph(files, read, known);
  const ms = Date.now() - started;
  assert.ok(ms < 5000, `graph build took ${ms}ms, expected well under 5000ms`);
  // Spot-check correctness is unchanged.
  assert.equal(
    resolveSpecifier("tests/x.test.js", "../server/café.mjs", new Set([nfc])),
    nfc,
  );
});
