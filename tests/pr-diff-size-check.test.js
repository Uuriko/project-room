// PR diff-size gate: diffs over MAX_DIFF_LINES (default 300) must carry a
// "Large diff justification:" section in the PR body. Smaller diffs mean
// fewer rebase conflicts (PR #1530 needed 5 rebase cycles) and faster reviews.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIFF_LINES,
  checkDiffSize,
  isExcluded,
  resolveThreshold,
} from "../scripts/pr-diff-size-check.mjs";

// "added\tremoved\tpath" lines, git --numstat format.
const numstat = (rows) =>
  rows.map(([added, removed, path]) => `${added}\t${removed}\t${path}`).join("\n");

const over = numstat([
  [150, 100, "server/http.mjs"],
  [100, 50, "server/store.mjs"],
]); // 400 counted lines

test("under the threshold passes without any justification", () => {
  const r = checkDiffSize({
    numstat: numstat([[100, 50, "server/http.mjs"], [60, 40, "tests/x.test.js"]]),
    prBody: "a plain body",
  });
  assert.equal(r.ok, true);
});

test("over the threshold without a justification fails", () => {
  const r = checkDiffSize({ numstat: over, prBody: "a plain body" });
  assert.equal(r.ok, false);
  assert.match(r.message, /412|400/i); // count appears in the message
  assert.match(r.message, /rebase/i); // explains WHY
});

test("over the threshold with a real justification passes", () => {
  const r = checkDiffSize({
    numstat: over,
    prBody: [
      "# PR title",
      "",
      "## Large diff justification:",
      "This migrates the entire auth middleware in one atomic commit so no",
      "half-migrated state ships; splitting would break the gate between the",
      "old and new session formats.",
      "",
      "## Testing",
      "npm test",
    ].join("\n"),
  });
  assert.equal(r.ok, true);
});

test("heading match is case-insensitive and works with fewer #'s", () => {
  const r = checkDiffSize({
    numstat: over,
    prBody: [
      "# large diff justification",
      "This touches three tightly-coupled modules whose tests run as one suite,",
      "so splitting would only duplicate CI cost without reducing review surface.",
    ].join("\n"),
  });
  assert.equal(r.ok, true);
});

test("a bare heading with trivial content still fails", () => {
  const r = checkDiffSize({
    numstat: over,
    prBody: "## Large diff justification:\n\nn/a\n",
  });
  assert.equal(r.ok, false);
});

test("lockfile and generated files are excluded from the count", () => {
  const r = checkDiffSize({
    numstat: numstat([
      [100, 50, "server/http.mjs"], // 150 counted
      [5000, 2000, "package-lock.json"], // excluded
      [3000, 1000, "dist/bundle.js"], // excluded
      [800, 200, "client/app.min.js"], // excluded
      [100, 50, "docs/site.js.map"], // excluded
    ]),
    prBody: "no justification",
  });
  assert.equal(r.ok, true);
  assert.equal(r.counted, 150);
});

test("yarn and pnpm locks are excluded too", () => {
  assert.equal(isExcluded("yarn.lock"), true);
  assert.equal(isExcluded("pnpm-lock.yaml"), true);
  assert.equal(isExcluded("bun.lockb"), true);
  assert.equal(isExcluded("package-lock.json"), true);
});

test("exactly-at-threshold passes without justification", () => {
  const r = checkDiffSize({
    numstat: numstat([[200, 100, "server/http.mjs"]]), // 300 = MAX_DIFF_LINES
    prBody: "no justification",
  });
  assert.equal(r.ok, true);
  assert.equal(MAX_DIFF_LINES, 300);
});

test("threshold is a single configurable constant, overridable by env", () => {
  assert.equal(resolveThreshold(), 300);
  process.env.DIFF_SIZE_THRESHOLD = "10";
  try {
    assert.equal(resolveThreshold(), 10);
    const r = checkDiffSize({
      numstat: numstat([[10, 1, "server/http.mjs"]]),
      prBody: "no justification",
      threshold: resolveThreshold(),
    });
    assert.equal(r.ok, false);
  } finally {
    delete process.env.DIFF_SIZE_THRESHOLD;
  }
});

test("binary numstat rows (dash counts) count as zero lines", () => {
  const r = checkDiffSize({ numstat: "-\t-\tassets/logo.png", prBody: "" });
  assert.equal(r.ok, true);
  assert.equal(r.counted, 0);
});

test("justification content stops at the next markdown heading", () => {
  const r = checkDiffSize({
    numstat: over,
    prBody: [
      "## Large diff justification:",
      "short",
      "## Testing",
      "lots of test detail here that must not count as justification content",
    ].join("\n"),
  });
  assert.equal(r.ok, false);
});
