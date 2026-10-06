// Owner-boundary tests for scripts/review-mechanical-report.mjs.
// The contract: renderReport() emits a stable machine-readable JSON shape
// (check/stage/pr/head/lint/tests/files_changed/lines/scope/generated_at)
// inside a markdown block marked with <!-- review-mechanical-report -->.
// Reviewers and tooling read that JSON; a dropped field or a lost marker
// silently breaks the clean-context judgment pass.
import test from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../scripts/review-mechanical-report.mjs";

function sampleScope(overrides = {}) {
  return {
    verdict: "clean",
    changedCount: 3,
    drift: [],
    declared: ["a.mjs"],
    ...overrides,
  };
}

test("report JSON carries the full machine-readable contract", () => {
  const { report } = renderReport({
    stage: "full",
    pr: "1585",
    head: "abc123",
    lint: "success",
    tests: "success",
    additions: "120",
    deletions: "30",
    scope: sampleScope(),
  });
  assert.equal(report.check, "review-mechanical");
  assert.equal(report.stage, "full");
  assert.equal(report.pr, 1585);
  assert.equal(report.head, "abc123");
  assert.equal(report.lint, "success");
  assert.equal(report.tests, "success");
  assert.equal(report.files_changed, 3);
  assert.equal(report.lines_added, 120);
  assert.equal(report.lines_deleted, 30);
  assert.deepEqual(report.scope, { verdict: "clean", drift: [], declared: ["a.mjs"] });
  assert.match(report.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("markdown contains the machine-readable marker and a parseable JSON block", () => {
  const { markdown, report } = renderReport({
    stage: "fast",
    pr: 7,
    head: "def456",
    lint: "pending",
    tests: "pending",
    additions: 5,
    deletions: 1,
    scope: sampleScope(),
  });
  assert.ok(markdown.includes("<!-- review-mechanical-report -->"));
  const m = markdown.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, "expected a fenced json block");
  assert.deepEqual(JSON.parse(m[1]), report);
});

test("drift verdict surfaces the drifted files in both JSON and markdown", () => {
  const { report, markdown } = renderReport({
    stage: "full",
    pr: 7,
    head: "def456",
    lint: "success",
    tests: "success",
    additions: 5,
    deletions: 1,
    scope: sampleScope({ verdict: "drift", drift: ["server/surprise.mjs"] }),
  });
  assert.equal(report.scope.verdict, "drift");
  assert.deepEqual(report.scope.drift, ["server/surprise.mjs"]);
  assert.ok(markdown.includes("server/surprise.mjs"));
  assert.ok(markdown.includes("scope drift"));
});

test("undeclared verdict tells the reviewer to check scope by hand", () => {
  const { markdown } = renderReport({
    stage: "fast",
    pr: 7,
    head: "def456",
    lint: "pending",
    tests: "pending",
    additions: 5,
    deletions: 1,
    scope: sampleScope({ verdict: "undeclared", declared: [] }),
  });
  assert.ok(markdown.includes("claim-files"));
  assert.ok(markdown.includes("| claim scope | undeclared |"));
});
