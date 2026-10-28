// Regression guard for the NFD path index in scripts/verify-affected.mjs.
//
// The NFC index that matches NFD spellings must be built once per graph, not
// once per import specifier. Rebuilding it per specifier turns
// buildReverseGraph into O(specifiers × known) NFC normalizations — measured
// at 20,045,750 normalizations and +30s of graph-build time on the real repo
// (2186 code files) against PR #2535's head, for a script documented as ~30s
// end-to-end.
//
// The count below is deterministic (it counts String.prototype.normalize
// calls, not wall time): 0 on the pre-NFD code, ~200 with a hoisted index
// (one build over `known`, fast path per specifier), ~40000 when the index is
// rebuilt per distinct specifier.
import test from "node:test";
import assert from "node:assert/strict";
import { buildReverseGraph } from "../scripts/verify-affected.mjs";

test("buildReverseGraph does not rebuild the NFC index per import specifier", () => {
  const knownFiles = [];
  for (let i = 0; i < 200; i++) knownFiles.push(`server/mod${i}.mjs`);
  const known = new Set(knownFiles);
  const specs = [];
  for (let i = 0; i < 500; i++) specs.push(`import { v${i} } from "../server/mod${i % 200}.mjs";`);
  const read = (file) =>
    file === "tests/many-imports.test.js" ? `${specs.join("\n")}\n` : "export const x = 1;\n";
  const files = [...knownFiles, "tests/many-imports.test.js"];

  let normalizeCalls = 0;
  const original = String.prototype.normalize;
  String.prototype.normalize = function (...args) {
    normalizeCalls += 1;
    return original.apply(this, args);
  };
  try {
    buildReverseGraph(files, read, known);
  } finally {
    String.prototype.normalize = original;
  }
  // One index build over `known` plus a small constant per specifier stays
  // far under one full index rebuild per distinct specifier (200 × 200 = 40,000).
  assert.ok(
    normalizeCalls < 10_000,
    `expected < 10000 NFC normalizations for 500 specifiers over 200 known files, got ${normalizeCalls}`
  );
});
