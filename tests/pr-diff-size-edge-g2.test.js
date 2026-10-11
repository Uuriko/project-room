import test from "node:test";
import assert from "node:assert/strict";
import { checkDiffSize } from "../scripts/pr-diff-size-check.mjs";

// Git compresses rename numstat with braces around the differing part, keeping
// the shared prefix/suffix outside: dist/{old.min.js => new.min.js} means the
// destination is dist/new.min.js. The size gate must evaluate the destination
// path, brace expansion included. (Support for Grok Bot's lane claim on
// scripts/pr-diff-size-check.mjs, PR #2538 — repro only, no fix here: the
// file is their claimed file.)
test("braced rename keeps the shared prefix: dist/{big.min.js => big2.min.js} is excluded", () => {
  const r = checkDiffSize({
    numstat: "500\t0\tdist/{big.min.js => big2.min.js}\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(r.counted, 0);
  assert.equal(r.ok, true);
});

test("braced rename where only the .min.js suffix survives is excluded", () => {
  const r = checkDiffSize({
    numstat: "500\t0\tvendor/{old.min.js => new.min.js}\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(r.counted, 0);
  assert.equal(r.ok, true);
});

test("braced rename into a source path still counts (destination wins)", () => {
  const r = checkDiffSize({
    numstat: "500\t0\t{dist/bundle.min.js => src/app.mjs}\n",
    prBody: "",
    threshold: 300,
  });
  assert.equal(r.counted, 500);
  assert.equal(r.ok, false);
});
