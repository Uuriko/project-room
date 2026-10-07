// 200-hard-tasks #82: import-closure lint covers dynamic imports.
// The closure linter (scripts/runtime-import-closure.mjs) must follow
// dynamic import() with string-literal relative specifiers, so a new
// server module reachable ONLY through a dynamic import is still caught
// by the runtime-package allowlist drift guard. node: builtins, bare
// specifiers, and ${...} templates stay ignored.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importClosure } from "../scripts/runtime-import-closure.mjs";
import { allowed } from "../scripts/runtime-package.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "closure-dyn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("dynamic import() with a relative string literal is followed", t => {
  const dir = fixture(t, {
    "entry.mjs": `const m = await import("./dynamic-mod.mjs");\nconsole.log(m);`,
    "dynamic-mod.mjs": `export const x = 1;`,
  });
  const closure = importClosure("entry.mjs", dir);
  assert.ok(closure.has("dynamic-mod.mjs"), "dynamically imported module is in the closure");
});

test("dynamic template literal without interpolation is followed", t => {
  const dir = fixture(t, {
    "entry.mjs": "const m = await import(`./tpl-mod.mjs`);",
    "tpl-mod.mjs": `export const x = 1;`,
  });
  assert.ok(importClosure("entry.mjs", dir).has("tpl-mod.mjs"));
});

test("dynamic node: and bare imports are ignored", t => {
  const dir = fixture(t, {
    "entry.mjs": `const a = await import("node:https");\nconst b = await import("some-package");`,
  });
  assert.deepEqual([...importClosure("entry.mjs", dir)], [],
    "no unresolvable dynamic imports leak into the closure");
});

test("dynamic template with ${} interpolation is skipped, not misresolved", t => {
  const dir = fixture(t, {
    "entry.mjs": "const name = 'x';\nconst m = await import(`./${name}.mjs`);",
  });
  assert.deepEqual([...importClosure("entry.mjs", dir)], [],
    "interpolated template cannot be resolved statically");
});

test("seeded violation: new server module reachable only via dynamic import is caught", t => {
  // Simulates the #588/#604 class of break through a dynamic import: the
  // module is imported, so the drift guard must flag it as unallowlisted.
  const dir = fixture(t, {
    "server.mjs": `export async function boot() { return import("./server/secret-new-module.mjs"); }`,
    "server/secret-new-module.mjs": `export const y = 2;`,
  });
  const closure = importClosure("server.mjs", dir);
  assert.ok(closure.has("server/secret-new-module.mjs"),
    "dynamic-only module is in the closure, so the allowlist check flags it");
  const missing = [...closure].filter(p => !allowed.has(p));
  assert.deepEqual(missing, ["server/secret-new-module.mjs"],
    "the unallowlisted dynamic module is reported as missing");
});

test("zero false positives: dynamic pass changes nothing on the real tree", t => {
  // Main's packaged tree has no dynamic relative imports (only node:
  // builtins), so the extended closure must equal the static closure and
  // every member must already be allowlisted.
  const closure = importClosure("server.mjs", repository);
  const missing = [...closure].filter(path => !allowed.has(path)).sort();
  assert.deepEqual(missing, [], `unallowlisted after dynamic pass: ${missing.join(", ")}`);
  assert.ok(closure.size > 50, `closure is non-trivial (${closure.size} modules)`);
});
