import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// M-57: the old `haystack.includes(name sans .mjs)` substring check falsely
// counted modules as tested ("activity" matched "activity-feed"; "prefix"
// matched "prefix-extended"). F-33 (2026-10-18): findUntested must match
// real import specifiers ONLY — a path-anchored mention (the exact
// `server/<rel>` token in a comment) no longer counts as a test reference.
test("F-33: findUntested matches direct import specifiers only, not substrings or path mentions", async t => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dir = mkdtempSync(join(root, ".tmp", "f33-"));
  const serverDir = join(dir, "server");
  const testDir = join(dir, "tests");
  mkdirSync(join(serverDir, "sub"), { recursive: true });
  mkdirSync(testDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ["foo.mjs", "dyn.mjs", "srcread.mjs", "noted.mjs", "qux.mjs", "prefix.mjs", "prefix-extended.mjs"])
    writeFileSync(join(serverDir, f), "export const x = 1;\n");
  writeFileSync(join(serverDir, "sub", "deep.mjs"), "export const x = 1;\n");
  writeFileSync(join(testDir, "a.test.js"), [
    'import { x } from "../server/foo.mjs";',
    'const d = await import("../server/dyn.mjs");',
    'const u = new URL("../server/srcread.mjs", import.meta.url);',
    "// covers server/noted.mjs via HTTP boundary",
    "// qux is great (prose mention only, no reference)",
    "// see server/prefix-extended.mjs for the extended variant",
    ""
  ].join("\n"));
  writeFileSync(join(testDir, "b.test.js"), 'import { y } from "../server/sub/deep.mjs";\n');

  const { findUntested } = await import("../scripts/untested-modules-lint.mjs");
  const { modules, untested } = findUntested(serverDir, testDir);
  assert.equal(modules.length, 8);
  // noted: path-anchored mention only — counted as tested before F-33, and a
  // fixture module referenced only by a path string must FAIL the lint now,
  // i.e. land in the untested set. prefix-extended is in the same position.
  // qux: prose substring only. prefix: only "prefix-extended" is mentioned.
  assert.deepEqual([...untested].sort(), ["noted.mjs", "prefix-extended.mjs", "prefix.mjs", "qux.mjs"]);
});

test("F-33: waiver rows are decisions on the record - named module, real reason, no overlap", async () => {
  const { WAIVED, GRANDFATHERED } = await import("../scripts/untested-modules-lint.mjs");
  const names = WAIVED.map(w => w.module);
  assert.equal(new Set(names).size, names.length, "waiver modules are unique");
  for (const w of WAIVED) {
    assert.ok(w.module.endsWith(".mjs"), `waiver names a module: ${w.module}`);
    assert.ok(typeof w.reason === "string" && w.reason.trim().length >= 20, `waiver for ${w.module} carries a real reason`);
    assert.ok(!GRANDFATHERED.includes(w.module), `${w.module} is not in both lists`);
  }
});

test("F-33: every untested module in the real tree is grandfathered or waived", async () => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const { findUntested, WAIVED, GRANDFATHERED } = await import("../scripts/untested-modules-lint.mjs");
  const { untested } = findUntested(join(root, "server"), join(root, "tests"));
  const allowed = new Set([...GRANDFATHERED, ...WAIVED.map(w => w.module)]);
  assert.deepEqual(untested.filter(name => !allowed.has(name)), []);
  // And the lists only shrink: a listed module that gained a direct import
  // must be removed from its list.
  assert.deepEqual([...allowed].filter(name => !untested.includes(name)), []);
});
