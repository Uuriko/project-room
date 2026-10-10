import test from "node:test";
import assert from "node:assert/strict";
import { relatedTests, resolveSpecifier, buildReverseGraph } from "../scripts/verify-affected.mjs";

const nfc = "server/café.mjs";
const nfd = "server/cafe\u0301.mjs";

test("an NFD changed path selects the test that names the NFC file", () => {
  assert.notEqual(nfc, nfd);
  const tests = ["tests/café.test.js"];
  const read = (file) => file === "tests/café.test.js"
    ? "import { x } from \"../server/café.mjs\";\n"
    : "export const x = 1;\n";
  const mentioned = relatedTests({ changed: [nfd], tests, reverse: new Map(), read });
  assert.equal(mentioned.get("tests/café.test.js")?.via, "mentions server/cafe\u0301.mjs");

  const files = [nfc, "tests/café.test.js"];
  const importing = (file) => file.endsWith(".test.js")
    ? "import { x } from \"../server/cafe\u0301\";\n"
    : "export const x = 1;\n";
  const reverse = buildReverseGraph(files, importing);
  assert.ok(reverse.get(nfc)?.has("tests/café.test.js"));
  const imported = relatedTests({ changed: [nfd], tests, reverse, read: importing });
  assert.equal(imported.get("tests/café.test.js")?.via, "imports server/cafe\u0301.mjs");

  assert.equal(resolveSpecifier("tests/café.test.js", "../server/cafe\u0301.mjs", new Set([nfc])), nfc);
  assert.equal(resolveSpecifier("tests/café.test.js", "../server/Café.mjs", new Set([nfc])), null);
  assert.equal(resolveSpecifier("tests/café.test.js", "../../café.mjs", new Set([nfc])), null);

  const changedTest = relatedTests({
    changed: ["tests/cafe\u0301.test.js"],
    tests,
    reverse: new Map(),
    read: () => "",
  });
  assert.equal(changedTest.get("tests/café.test.js")?.via, "changed");
});
