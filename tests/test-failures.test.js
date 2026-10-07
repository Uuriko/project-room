import test from "node:test";
import assert from "node:assert/strict";
import { parseFailingTests, formatFailureComment } from "../scripts/failing-tests.mjs";

test("parseFailingTests extracts spec-reporter failure lines", () => {
  const out = [
    "✔ first passing test (1.234567ms)",
    "✖ frozen deployment manifest pins the recovery helper (1.360142ms)",
    "✔ another passing test (0.498282ms)",
    "ℹ fail 1",
  ].join("\n");
  assert.deepEqual(parseFailingTests(out), [
    "frozen deployment manifest pins the recovery helper",
  ]);
});

test("parseFailingTests captures indented nested failures too", () => {
  const out = [
    "✔ parent suite (3.200000ms)",
    "    ✖ nested child blows up (0.512345ms)",
    "    ✔ nested child fine (0.498282ms)",
    "✖ parent suite (12.000000ms)",
  ].join("\n");
  assert.deepEqual(parseFailingTests(out), [
    "nested child blows up",
    "parent suite",
  ]);
});

test("parseFailingTests keeps names containing parentheses", () => {
  const out = "✖ fund -> timeout -> refund: finality-only path (needs verdict) (6.633133ms)";
  assert.deepEqual(parseFailingTests(out), [
    "fund -> timeout -> refund: finality-only path (needs verdict)",
  ]);
});

test("parseFailingTests falls back to TAP not-ok lines", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - first passing test",
    "not ok 2 - frozen deployment manifest pins the recovery helper",
    "ok 3 - another passing test",
    "# fail 1",
  ].join("\n");
  assert.deepEqual(parseFailingTests(tap), [
    "frozen deployment manifest pins the recovery helper",
  ]);
});

test("parseFailingTests dedupes repeats and caps at twenty", () => {
  const dupes = ["✖ same flake (1.000000ms)", "✖ same flake (2.000000ms)"];
  assert.deepEqual(parseFailingTests(dupes.join("\n")), ["same flake"]);
  const lines = [];
  for (let i = 0; i < 25; i++) lines.push(`✖ unique flake ${i} (1.000000ms)`);
  const out = parseFailingTests(lines.join("\n"));
  assert.equal(out.length, 20);
  assert.equal(out[0], "unique flake 0");
  assert.equal(out[19], "unique flake 19");
});

test("parseFailingTests ignores reporter noise", () => {
  const out = [
    "# Subtest: something",
    "Bail out! disaster",
    "✔ fine (1.000000ms)",
    "ℹ fail 1",
    "✖ failing tests:",
  ].join("\n");
  assert.deepEqual(parseFailingTests(out), []);
});

test("parseFailingTests handles empty input", () => {
  assert.deepEqual(parseFailingTests(""), []);
  assert.deepEqual(parseFailingTests(null), []);
});

test("formatFailureComment lists failing tests with a run link", () => {
  const body = formatFailureComment({
    shard: 3,
    total: 3,
    failures: ["alpha breaks", "beta breaks"],
    runUrl: "https://example.com/runs/1",
  });
  assert.match(body, /Unit test failures, shard 3\/3/);
  assert.match(body, /alpha breaks/);
  assert.match(body, /beta breaks/);
  assert.match(body, /https:\/\/example\.com\/runs\/1/);
});

test("formatFailureComment without failure names falls back to the log pointer", () => {
  const body = formatFailureComment({ shard: 1, total: 3, failures: [], runUrl: "" });
  assert.match(body, /shard 1\/3/);
  assert.match(body, /job log/);
});
