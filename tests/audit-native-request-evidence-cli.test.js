// Worker-39 (guild-06) fail-first: audit-native-request-evidence.mjs must fail
// clean on unreadable/unparsable input files — stderr message + exit 2 —
// not a raw ENOENT/SyntaxError stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "anre-"));
const missing = join(dir, "nope.json");
const bad = join(dir, "bad.json");
writeFileSync(bad, "{not json");

for (const [label, files] of [
  ["missing input file", [missing, missing, missing, missing]],
  ["malformed json", [bad, bad, bad, bad]],
]) {
  test(`${label}: exits 2 with a clean message, no stack trace`, () => {
    const r = spawnSync(process.execPath,
      [`${root}/scripts/audit-native-request-evidence.mjs`, ...files],
      { encoding: "utf8", timeout: 20000, cwd: root });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
    assert.match(r.stderr, /cannot read/i, "names the unreadable input");
  });
}

test("wrong argc still exits 2 with usage", () => {
  const r = spawnSync(process.execPath,
    [`${root}/scripts/audit-native-request-evidence.mjs`, "--help"],
    { encoding: "utf8", timeout: 20000, cwd: root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/i);
});
