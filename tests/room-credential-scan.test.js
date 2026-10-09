import test from "node:test";
import assert from "node:assert/strict";
import { scanText } from "../server/secret-scan.mjs";
import { scanAddedUnits } from "../scripts/secret-scan-diff.mjs";

const identity = (suffix) => "pri_" + suffix;
const apiKey = (suffix) => "rak_" + suffix;
const guest = (suffix) => "ga1." + suffix;

function roomFindings(text) {
  return scanText(text).filter(finding => finding.rule === "room-credential");
}

test("minted-length room credentials are findings, including a trailing hyphen", () => {
  const cases = [
    identity("a".repeat(43)),
    identity("a".repeat(42) + "-"),
    apiKey("b".repeat(32)),
    apiKey("b".repeat(31) + "-"),
    guest("c".repeat(43)),
    guest("c".repeat(42) + "-"),
  ];
  for (const secret of cases) {
    const findings = roomFindings(`const saved = "${secret}";`);
    assert.equal(findings.length, 1, "expected one room-credential finding");
    assert.equal(findings[0].preview.includes(secret), false);
  }
});

test("a short prefix is not a room credential", () => {
  assert.equal(roomFindings(`const saved = "${identity("a".repeat(10))}";`).length, 0);
});

test("the diff gate reports a room credential on an in-scope added line", () => {
  const secret = apiKey("d".repeat(31) + "-");
  const findings = scanAddedUnits([{ path: "server/pay.mjs", line: 4, text: `const saved = "${secret}";` }], []);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /server\/pay\.mjs:4 \[room-credential\]/);
  assert.equal(findings[0].includes(secret), false);
});
