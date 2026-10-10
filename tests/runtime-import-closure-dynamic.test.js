// Fail-first coverage for hard task 82: the import-closure lint must follow
// relative dynamic import() specifiers and JSON import-attributes, not just
// static ESM imports. Without this, a server module loaded via
// `await import("./helper.mjs")` or `import data from "./x.json" with
// { type: "json" }` is invisible to the runtime-package allowlist test while
// still required at runtime — the exact #588/#604/#590/#592/#606 drift class.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importClosure } from "../scripts/runtime-import-closure.mjs";

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "room-closure-dynamic-"));
  mkdirSync(join(dir, "deep"), { recursive: true });
  const files = {
    // Five seeded violations the lint must catch.
    "entry.mjs": `import "./static-dep.mjs";
import config from "./config.json" with { type: "json" };
export async function load() {
  const a = await import("./dyn-a.mjs");
  const b = await import('./dyn-b.js');
  return [a, b, config];
}
export function lazy() { return import("./deep/dyn-d.mjs"); }
export const multi = await import(
  "./dyn-e.mjs"
);
// Four anti-cases the lint must NOT follow (no false positives).
const spec = "./dyn-var.mjs";
export const byVar = () => import(spec);
export const byTemplate = (n) => import(\`./\${n}.mjs\`);
export const builtin = () => import("node:fs");
export const methodCall = (loader) => loader.import("./dyn-method.mjs");
`,
    "static-dep.mjs": `export const x = 1;\n`,
    "dyn-a.mjs": `export const a = 1;\n`,
    "dyn-b.js": `export const b = 2;\n`,
    "config.json": `{"k":"v"}\n`,
    "deep/dyn-d.mjs": `export const d = 4;\n`,
    "dyn-e.mjs": `export const e = 5;\n`,
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return dir;
}

test("importClosure follows relative dynamic import() and JSON import attributes", t => {
  const dir = writeFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const closure = importClosure("entry.mjs", dir);
  const paths = [...closure].sort();
  // The five seeded violations must be caught.
  for (const expected of ["static-dep.mjs", "dyn-a.mjs", "dyn-b.js", "config.json", "deep/dyn-d.mjs", "dyn-e.mjs"]) {
    assert.ok(paths.includes(expected), `closure must follow ${expected}; got: ${paths.join(", ")}`);
  }
  // The entry itself is never reported as its own dependency.
  assert.ok(!paths.includes("entry.mjs"), "entry must not appear in its own closure");
  // Anti-cases: builtins, variables, template literals, and member-call
  // .import() must not leak into the closure (no false positives).
  for (const absent of ["dyn-var.mjs", "dyn-method.mjs", "node:fs"]) {
    assert.ok(!paths.some(p => p.includes(absent)), `closure must not contain ${absent}; got: ${paths.join(", ")}`);
  }
  assert.ok(!paths.some(p => p.includes("${")), `closure must not contain template-literal specs; got: ${paths.join(", ")}`);
});

test("importClosure on the real tree gains no false positives from the extension", () => {
  // Zero-false-positive bar on main: extending the lint to dynamic imports
  // and JSON must not newly flag anything in the actual server tree.
  // The tree's only dynamic imports are node: builtins (web-fetch,
  // webhook-dispatch) and no reachable JSON import-attributes exist, so the
  // extended closure must be byte-identical to the static-only closure.
  const repo = new URL("..", import.meta.url).pathname;
  const closure = importClosure("server.mjs", repo);
  for (const p of closure) {
    assert.match(p, /\.(mjs|js|cjs|json)$/, `unexpected closure entry ${p}`);
    assert.ok(!p.includes("node:"), `builtin leaked into closure: ${p}`);
  }
  // No entry may escape the repo root.
  for (const p of closure) assert.ok(!p.startsWith("../") && p !== "..", `closure escaped repo: ${p}`);
});
