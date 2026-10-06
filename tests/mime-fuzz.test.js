// MIME parser fuzz gate (backlog Q005): the parser must never hang, crash,
// or throw an uncaught (non-MimeError) exception on any byte input.
//
// Two layers share one owner, scripts/fuzz-mime.mjs:
//  1. The seed corpus (tests/fuzz/mime-corpus/): 26 pathological fixtures
//     with pinned outcomes (clean parse or a specific MimeError code). A
//     fixture that starts throwing something else, or a new pathological
//     input class the parser mishandles, lands here as a new fixture.
//  2. A short deterministic random sweep (fixed seed, bounded iterations):
//     generational + mutational + byte-soup inputs against the same
//     invariant. The long scheduled sweep lives in scripts/fuzz-mime.mjs
//     and .github/workflows/mime-fuzz.yml.
//
// Authoring-gate answers: the invariant guarded is "no hang / no crash / no
// unclean throw on arbitrary bytes", which tests/mime-message.test.js does
// not cover (it asserts parsing of well-formed inputs). The credible
// regression is a future parser change introducing unbounded recursion,
// a catastrophic regex, or an uncaught throw on malformed input. No
// production seam is added; the test uses the public parseMimeMessage entry.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, checkCorpusEntry, runFuzz } from "../scripts/fuzz-mime.mjs";

const CORPUS_MAX_MS = 10000; // corpus fixtures are large; generous vs ~30ms observed

test("mime fuzz corpus: pathological inputs parse or raise the pinned MimeError", () => {
  const failures = [];
  for (const entry of loadCorpus()) {
    const { problem } = checkCorpusEntry(entry, { maxMs: CORPUS_MAX_MS });
    if (problem) failures.push(`${entry.file}: ${problem}`);
  }
  assert.equal(failures.length, 0, `corpus invariant failures:\n${failures.join("\n")}`);
});

test("mime fuzz: bounded deterministic random sweep holds the invariant", { timeout: 120000 }, () => {
  const reportDir = join(tmpdir(), `mime-fuzz-test-${process.pid}`);
  const { failures, stats } = runFuzz({
    seed: 20261006,
    iterations: 1500,
    budgetMs: 90000,
    maxMs: 5000,
    reportDir,
    skipCorpus: true, // corpus has its own test above; this sweep is the random phase
    quiet: true,
  });
  assert.equal(failures.length, 0,
    `${failures.length} invariant failures in ${stats.randomCases} random cases ` +
    `(failing inputs saved under ${reportDir}):\n${failures.slice(0, 5).map(f => `  ${f.label}: ${f.detail}`).join("\n")}`);
});
