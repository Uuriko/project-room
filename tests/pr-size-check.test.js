// Tests for scripts/pr-size-check.mjs.
//
// Authoring gate answers:
// 1. Contract: evaluate() maps (diff size, PR body, limit, mode) to a
//    verdict. The workflow posts or fails on that verdict; if the mapping
//    drifts, over-budget PRs pass silently or small PRs get flagged.
// 2. Credible regression: a boundary edit (total > limit changed to >=),
//    a heading-detection change that misses "## Why this is large", or a
//    mode/config regression that ignores require mode.
// 3. No existing coverage: the script is new; nothing else guards this
//    mapping. Table-driven at the module boundary (the same functions the
//    CLI calls), no test-only seams.
import test from "node:test";
import assert from "node:assert/strict";
import {
  countLines,
  countNumstat,
  findJustification,
  evaluate,
  loadConfig,
  DEFAULT_LIMIT,
  DEFAULT_MODE,
} from "../scripts/pr-size-check.mjs";

const diffOf = (added, deleted) =>
  `diff --git a/f b/f\n--- a/f\n+++ b/f\n` +
  `${"+x\n".repeat(added)}${"-y\n".repeat(deleted)}`;

test("countLines: adds and deletes from a unified diff", () => {
  const c = countLines(diffOf(10, 4));
  assert.equal(c.added, 10);
  assert.equal(c.deleted, 4);
  assert.equal(c.total, 14);
  assert.equal(c.binary, 0);
});

test("countLines: file headers and hunk headers are not changes", () => {
  const c = countLines(
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n",
  );
  assert.deepEqual(c, { added: 1, deleted: 1, binary: 0, total: 2 });
});

test("countLines: binary files count as one changed line each", () => {
  const c = countLines("diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n");
  assert.equal(c.binary, 1);
  assert.equal(c.total, 1);
});

test("countNumstat: parses git numstat output, binaries count once", () => {
  const c = countNumstat("10\t4\tsrc/a.js\n-\t-\tassets/logo.png\n");
  assert.deepEqual(c, { added: 10, deleted: 4, binary: 1, total: 15 });
});

const GOOD_BODY =
  "## Summary\n\nRefactors the worker.\n\n## Why this is large\n\n" +
  "This touches every call site of the old API because the signature changed; " +
  "splitting would leave main in a half-migrated state for a week.\n";

test("findJustification: accepts a real justification section", () => {
  assert.equal(findJustification(GOOD_BODY), true);
});

test("findJustification: rejects an empty justification heading", () => {
  assert.equal(findJustification("## Summary\n\nStuff.\n\n## Why this is large\n"), false);
});

test("findJustification: rejects a too-short justification", () => {
  assert.equal(findJustification("## Why this is large\n\nIt is big.\n"), false);
});

test("findJustification: heading variants and case are accepted", () => {
  const filler = "x".repeat(60);
  assert.equal(findJustification(`## SIZE JUSTIFICATION\n\n${filler}\n`), true);
  assert.equal(findJustification(`### Justification\n\n${filler}\n`), true);
});

test("findJustification: stops capturing at the next heading", () => {
  const filler = "x".repeat(60);
  assert.equal(findJustification(`## Why this is large\n\n${filler}\n## Testing\n\nDone.\n`), true);
});

test("findJustification: no heading means no justification", () => {
  assert.equal(findJustification("## Summary\n\n" + "x".repeat(200) + "\n"), false);
});

test("evaluate: under budget passes regardless of body", () => {
  const r = evaluate({ counts: { added: 100, deleted: 50, binary: 0, total: 150 }, prBody: "" });
  assert.equal(r.verdict, "pass");
  assert.equal(r.over, false);
});

test("evaluate: exactly at the limit is not over", () => {
  const r = evaluate({ counts: { added: 300, deleted: 0, binary: 0, total: 300 }, prBody: "" });
  assert.equal(r.verdict, "pass");
  assert.equal(r.over, false);
});

test("evaluate: one line over without justification warns in default mode", () => {
  const r = evaluate({ counts: { added: 301, deleted: 0, binary: 0, total: 301 }, prBody: "" });
  assert.equal(r.over, true);
  assert.equal(r.justified, false);
  assert.equal(r.verdict, "warn");
});

test("evaluate: over budget with justification passes", () => {
  const r = evaluate({ counts: { added: 900, deleted: 0, binary: 0, total: 900 }, prBody: GOOD_BODY });
  assert.equal(r.over, true);
  assert.equal(r.justified, true);
  assert.equal(r.verdict, "pass");
});

test("evaluate: require mode fails instead of warning", () => {
  const r = evaluate({
    counts: { added: 900, deleted: 0, binary: 0, total: 900 },
    prBody: "",
    mode: "require",
  });
  assert.equal(r.verdict, "fail");
});

test("evaluate: custom limit is honored", () => {
  const counts = { added: 250, deleted: 0, binary: 0, total: 250 };
  assert.equal(evaluate({ counts, prBody: "", limit: 200 }).verdict, "warn");
  assert.equal(evaluate({ counts, prBody: "", limit: 500 }).verdict, "pass");
});

test("loadConfig: defaults without config file or env", () => {
  const savedLimit = process.env.PR_SIZE_LIMIT;
  const savedMode = process.env.PR_SIZE_MODE;
  delete process.env.PR_SIZE_LIMIT;
  delete process.env.PR_SIZE_MODE;
  const cfg = loadConfig("/nonexistent-dir-for-default-config");
  assert.equal(cfg.limit, DEFAULT_LIMIT);
  assert.equal(cfg.mode, DEFAULT_MODE);
  if (savedLimit !== undefined) process.env.PR_SIZE_LIMIT = savedLimit;
  if (savedMode !== undefined) process.env.PR_SIZE_MODE = savedMode;
});

test("loadConfig: env overrides defaults", () => {
  const savedLimit = process.env.PR_SIZE_LIMIT;
  const savedMode = process.env.PR_SIZE_MODE;
  process.env.PR_SIZE_LIMIT = "500";
  process.env.PR_SIZE_MODE = "require";
  const cfg = loadConfig("/nonexistent-dir-for-default-config");
  assert.equal(cfg.limit, 500);
  assert.equal(cfg.mode, "require");
  if (savedLimit === undefined) delete process.env.PR_SIZE_LIMIT;
  else process.env.PR_SIZE_LIMIT = savedLimit;
  if (savedMode === undefined) delete process.env.PR_SIZE_MODE;
  else process.env.PR_SIZE_MODE = savedMode;
});
