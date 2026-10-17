// PR diff-size gate: diffs over MAX_DIFF_LINES (default 300) must carry a
// "Large diff justification:" section in the PR body. Smaller diffs mean
// fewer rebase conflicts (PR #1530 needed 5 rebase cycles) and faster reviews.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIFF_LINES,
  bodyFingerprint,
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

test("a git-quoted generated path is excluded; a quoted source path still counts", () => {
  const generated = checkDiffSize({
    numstat: "400\t0\t\"dist/caf\\303\\251.min.js\"\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(generated.counted, 0);
  assert.equal(generated.ok, true);
  const renamed = checkDiffSize({
    numstat: "400\t0\t\"src/a.mjs\" => \"dist/caf\\303\\251.min.js\"\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(renamed.counted, 0);
  assert.equal(renamed.ok, true);
  const source = checkDiffSize({
    numstat: "400\t0\t\"server/caf\\303\\251.mjs\"\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(source.counted, 400);
  assert.equal(source.ok, false);
});

test("renames are judged by the destination path, in both rename forms", () => {
  // A generated file renamed INTO source counts in full: the destination is
  // what the gate will review, not the generated origin.
  const intoSource = checkDiffSize({
    numstat: "400\t0\t\"dist/caf\\303\\251.min.js\" => \"src/caf\\303\\251.mjs\"\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(intoSource.counted, 400);
  assert.equal(intoSource.ok, false);
  // Brace form (shared prefix/suffix): the destination is prefix + new +
  // suffix, so a rename whose middle becomes generated is excluded...
  const braceIntoGenerated = checkDiffSize({
    numstat: "400\t0\tsrc/{old.js => new.min.js}\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(braceIntoGenerated.counted, 0);
  // ...and one whose middle leaves generated counts.
  const braceOutOfGenerated = checkDiffSize({
    numstat: "400\t0\tsrc/{old.min.js => new.js}\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(braceOutOfGenerated.counted, 400);
  // The brace form is C-quoted whole when it is not plain ASCII.
  const braceQuoted = checkDiffSize({
    numstat: "400\t0\t\"src/{ol\\303\\251.js => new.min.js}\"\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(braceQuoted.counted, 0);
});

test("malformed quoted paths fail safe: never throw, never partially decode", () => {
  // Each token below starts quoted but does not decode cleanly, so the raw
  // token is tested as-is and its lines count in full.
  for (const path of ["\"src/bad\\899.js\"", "\"src/oct\\777.js\"", "\"src/trail\\\""]) {
    const r = checkDiffSize({ numstat: `400\t0\t${path}\n`, prBody: "", threshold: 300 });
    assert.equal(r.counted, 400, path);
    assert.equal(r.ok, false, path);
  }
  // An unterminated quote is not a shape git emits; the gate must still
  // answer rather than throw.
  assert.doesNotThrow(() =>
    checkDiffSize({ numstat: "400\t0\t\"dist/caf\\303\\251.min.js\n", prBody: "" }));
});

test("verdict is a deterministic function of (numstat, body): same inputs, same verdict", () => {
  // Regression pin for the 2026-10-15 flake investigation: every same-head
  // diff-size flip in the 7-day sample traced to the PR body changing between
  // runs (justification added by an edit), never to the checker disagreeing
  // with itself. Identical inputs must give byte-identical results.
  const body = "Fixes #1234\n\nSome description.";
  const a = checkDiffSize({ numstat: over, prBody: body });
  const b = checkDiffSize({ numstat: over, prBody: body });
  assert.deepEqual(a, b);
  assert.equal(a.ok, false);
  // The flip shape itself: same numstat, body gains a justification section.
  const edited = checkDiffSize({
    numstat: over,
    prBody: body + "\n\n## Large diff justification:\n" +
      "One atomic migration; a split would ship a half-migrated state.",
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.counted, a.counted);
});

test("every message carries the body fingerprint so a flipped verdict is attributable", () => {
  const bodyA = "a plain body";
  const bodyB = "a plain body, lightly edited";
  const ra = checkDiffSize({ numstat: over, prBody: bodyA });
  const rb = checkDiffSize({ numstat: over, prBody: bodyB });
  assert.match(ra.message, new RegExp(`body sha256 ${bodyFingerprint(bodyA)}\\b`));
  assert.match(rb.message, new RegExp(`body sha256 ${bodyFingerprint(bodyB)}\\b`));
  assert.notEqual(bodyFingerprint(bodyA), bodyFingerprint(bodyB));
  assert.equal(bodyFingerprint(bodyA), bodyFingerprint(bodyA));
  // Under-threshold messages carry the fingerprint too.
  const under = checkDiffSize({ numstat: numstat([[10, 5, "a.js"]]), prBody: bodyA });
  assert.match(under.message, /body sha256 [0-9a-f]{12}\b/);
});

test("justification text on the heading line itself counts", () => {
  // The failure message shows the heading with a trailing colon; authors
  // naturally write the reason right after it. That form must not be a
  // silent non-match.
  const r = checkDiffSize({
    numstat: over,
    prBody: "## Large diff justification: one atomic migration across three coupled modules; splitting ships a broken half-state.",
  });
  assert.equal(r.ok, true);
});

test("inline heading text still has to meet the content minimum", () => {
  const r = checkDiffSize({
    numstat: over,
    prBody: "## Large diff justification: too big to split",
  });
  assert.equal(r.ok, false);
});

test("inline heading text combines with the lines that follow it", () => {
  const r = checkDiffSize({
    numstat: over,
    prBody: [
      "## Large diff justification: generated from a single schema change,",
      "so every file must move together or the contract tests fail.",
    ].join("\n"),
  });
  assert.equal(r.ok, true);
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
