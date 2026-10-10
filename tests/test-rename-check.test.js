// Tests for scripts/test-rename-check.mjs (FIX-42): the rename-proof spot-check.
// Authoring gate answers:
// 1. Behavior protected: the tool's verdict contract — RENAME-PROOF iff the
//    test fails under a source-only field rename, RENAME-BLIND iff it passes,
//    exit 2 (never a verdict) when the check itself cannot run. A regression
//    here silently inverts the signal the CONTRIBUTING.md convention relies on.
// 2. Credible regressions: verdict polarity flipped; word-boundary regex
//    over-matching (renaming `replayed` when asked for `replay`); baseline
//    gate dropped so a red test yields a bogus verdict; missing files
//    crashing instead of exiting 2.
// 3. No existing coverage: the script is new.
// 4. No production seam: the tested functions are the script's own units,
//    exported per repo convention (cf. scripts/agent-doctor.mjs); the CLI is
//    a thin wrapper over runRenameCheck. The e2e cases run real `node --test`
//    subprocesses against tiny synthetic projects — no mocks of the asserted
//    behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRenameToFiles,
  copyTreeForCheck,
  runRenameCheck,
} from "../scripts/test-rename-check.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(p, content) {
  writeFileSync(p, content, "utf8");
}

// A minimal synthetic project: one source module plus one test, so the
// end-to-end cases exercise the real copy → mutate → node --test pipeline
// in about a second instead of copying the whole repo.
const SYNTH_SRC = `export function summarize(input) {
  const count = input.count ?? 0;
  return { total: count * 2 };
};
`;
const SYNTH_PROOF_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./src.mjs";
test("doubles the count field", () => {
  assert.equal(summarize({ count: 21 }).total, 42);
});
`;
const SYNTH_BLIND_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./src.mjs";
test("empty input totals zero", () => {
  assert.equal(summarize({}).total, 0);
});
`;
const SYNTH_RED_TEST = `import test from "node:test";
import assert from "node:assert/strict";
test("always red", () => {
  assert.equal(1, 2);
});
`;

function makeSynthProject(testSource) {
  const root = makeTempDir("rename-check-synth-");
  write(join(root, "src.mjs"), SYNTH_SRC);
  write(join(root, "check.test.mjs"), testSource);
  return root;
}

function checkOpts(root, extra = {}) {
  return {
    root,
    test: "check.test.mjs",
    sources: ["src.mjs"],
    oldName: "count",
    newName: "countz",
    scratchParent: makeTempDir("rename-check-scratch-"),
    keep: true,
    ...extra,
  };
}

test("word-boundary rename leaves longer identifiers untouched", () => {
  const dir = makeTempDir("rename-check-unit-");
  const file = join(dir, "a.mjs");
  write(file, "const replay = 1;\nconst replayed = replay + 1; // replay note\n");
  const result = applyRenameToFiles([file], "replay", "replayz");
  assert.equal(result.totalReplacements, 3);
  assert.equal(result.files[0].replacements, 3);
  const after = result.files[0].newContent;
  assert.match(after, /const replayz = 1;/);
  assert.match(after, /const replayed = replayz \+ 1;/);
  assert.match(after, /\/\/ replayz note/);
  rmSync(dir, { recursive: true, force: true });
});

test("zero replacements throws so the caller can exit 2", () => {
  const dir = makeTempDir("rename-check-unit-");
  const file = join(dir, "a.mjs");
  write(file, "export const x = 1;\n");
  assert.throws(() => applyRenameToFiles([file], "nope", "nopez"), /no replacements/);
  rmSync(dir, { recursive: true, force: true });
});

test("copyTreeForCheck skips .git, .tmp and node_modules", () => {
  const root = makeTempDir("rename-check-copy-");
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".tmp"));
  mkdirSync(join(root, "node_modules"));
  write(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  write(join(root, "real.mjs"), "export const x = 1;\n");
  const dest = join(makeTempDir("rename-check-copydest-"), "tree");
  copyTreeForCheck(root, dest);
  assert.equal(existsSync(join(dest, "real.mjs")), true);
  assert.equal(existsSync(join(dest, ".git")), false);
  assert.equal(existsSync(join(dest, ".tmp")), false);
  assert.equal(existsSync(join(dest, "node_modules")), false);
  rmSync(root, { recursive: true, force: true });
});

test("copyTreeForCheck supports a scratch dir nested under root/.tmp", () => {
  // Regression: fs.cpSync refuses to copy a tree into a subdirectory of
  // itself even when the destination is filter-excluded; the scratch dir
  // lives under <root>/.tmp by design, so the copy must tolerate that.
  const root = makeTempDir("rename-check-nested-");
  mkdirSync(join(root, ".tmp"));
  write(join(root, "real.mjs"), "export const x = 1;\n");
  write(join(root, ".tmp", "junk.txt"), "scratch junk must not be copied\n");
  const dest = join(root, ".tmp", "rename-check", "scratch-1");
  copyTreeForCheck(root, dest);
  assert.equal(existsSync(join(dest, "real.mjs")), true);
  assert.equal(existsSync(join(dest, ".tmp")), false);
  rmSync(root, { recursive: true, force: true });
});

test("e2e: test coupled to the field name is RENAME-PROOF (exit 0)", () => {
  const root = makeSynthProject(SYNTH_PROOF_TEST);
  const result = runRenameCheck(checkOpts(root));
  assert.equal(result.baseline.passed, true);
  assert.equal(result.mutation.totalReplacements > 0, true);
  assert.equal(result.verdict, "RENAME-PROOF");
  assert.equal(result.exitCode, 0);
  assert.equal(result.mutated.passed, false);
  rmSync(root, { recursive: true, force: true });
  rmSync(result.scratchDir, { recursive: true, force: true });
});

test("e2e: test not touching the field is RENAME-BLIND (exit 1)", () => {
  const root = makeSynthProject(SYNTH_BLIND_TEST);
  const result = runRenameCheck(checkOpts(root));
  assert.equal(result.baseline.passed, true);
  assert.equal(result.verdict, "RENAME-BLIND");
  assert.equal(result.exitCode, 1);
  assert.equal(result.mutated.passed, true);
  rmSync(root, { recursive: true, force: true });
  rmSync(result.scratchDir, { recursive: true, force: true });
});

test("e2e: nested run under NODE_TEST_CONTEXT still executes the test", () => {
  // Regression: node --test skips running files when NODE_TEST_CONTEXT is
  // inherited ("run() is being called recursively"), exiting 0 — which used
  // to make every check report RENAME-BLIND when the script itself ran under
  // a test runner. The scratch run must be a fresh runner regardless.
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedWorker = process.env.NODE_TEST_WORKER_ID;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  process.env.NODE_TEST_WORKER_ID = "1";
  try {
    const root = makeSynthProject(SYNTH_PROOF_TEST);
    const result = runRenameCheck(checkOpts(root));
    assert.equal(result.baseline.passed, true);
    assert.equal(result.mutated.passed, false);
    assert.equal(result.verdict, "RENAME-PROOF");
    assert.equal(result.exitCode, 0);
    rmSync(root, { recursive: true, force: true });
    rmSync(result.scratchDir, { recursive: true, force: true });
  } finally {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = savedContext;
    if (savedWorker === undefined) delete process.env.NODE_TEST_WORKER_ID;
    else process.env.NODE_TEST_WORKER_ID = savedWorker;
  }
});

test("e2e: red baseline refuses to judge (exit 2)", () => {
  const root = makeSynthProject(SYNTH_RED_TEST);
  const result = runRenameCheck(checkOpts(root));
  assert.equal(result.baseline.passed, false);
  assert.equal(result.verdict, null);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /baseline/i);
  rmSync(root, { recursive: true, force: true });
  rmSync(result.scratchDir, { recursive: true, force: true });
});

test("e2e: missing test file exits 2 without a verdict", () => {
  const root = makeSynthProject(SYNTH_BLIND_TEST);
  const result = runRenameCheck(checkOpts(root, { test: "missing.test.mjs" }));
  assert.equal(result.verdict, null);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /not found/i);
  rmSync(root, { recursive: true, force: true });
});

test("e2e: field absent from source exits 2 without a verdict", () => {
  const root = makeSynthProject(SYNTH_BLIND_TEST);
  const result = runRenameCheck(checkOpts(root, { oldName: "absentField" }));
  assert.equal(result.verdict, null);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /no replacements/i);
  rmSync(root, { recursive: true, force: true });
});
