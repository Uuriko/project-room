import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// M-57: the old `haystack.includes(name sans .mjs)` substring check falsely
// counted modules as tested ("activity" matched "activity-feed"; "prefix"
// matched "prefix-extended"). findUntested must match real import specifiers
// or path-anchored references only.
test("M-57: findUntested matches import specifiers and anchored paths, not substrings", async t => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dir = mkdtempSync(join(root, ".tmp", "m57-"));
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
  // qux: prose substring only. prefix: only "prefix-extended" is referenced.
  // The old substring check counted both as tested.
  assert.deepEqual([...untested].sort(), ["prefix.mjs", "qux.mjs"]);
});
