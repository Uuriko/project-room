// tests/check-no-shadow-imports.test.js — regression tests for the shadow-import
// gate (scripts/check-no-shadow-imports.mjs). The gate must catch shadowing
// across ALL declaration forms, not just line-leading `const name =`:
// destructuring, multi-declarator, for-of, catch params, `var`, function
// params. Each fixture below uses the import earlier, then shadows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const script = join(root, "scripts", "check-no-shadow-imports.mjs");

// The gate hardcodes repo-relative scan roots (scripts/, tests/, cloudflare/
// ...), so the test builds a self-contained mini-repo: fixture files under
// scripts/ plus an empty cloudflare/ dir, and runs the gate with cwd there.
const runGate = (dir) => {
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
  // The gate reports findings on stderr (exit 1) and "no shadowed imports" on
  // stdout (exit 0); merge both so assertions read one stream.
  return { ...r, output: `${r.stdout}${r.stderr}` };
};

const withRepo = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "cloudflare"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "scripts", name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const prelude = (name) =>
  `import { ${name} } from "node:util";\nconsole.log(${name});\n`;

test("M-52: gate catches shadowing across all declaration forms", () => {
  const forms = {
    "plain-const": (n) => `const ${n} = 1;`,
    "multi-declarator": (n) => `const a = 1, ${n} = 2;`,
    "var-decl": (n) => `var ${n} = 3;`,
    "destructure-object": (n) => `const { x: ${n} } = obj;`,
    "destructure-object-shorthand": (n) => `const { ${n} } = obj;`,
    "destructure-array": (n) => `const [a, ${n}] = arr;`,
    "for-of": (n) => `for (const ${n} of items) { console.log(${n}); }`,
    "for-in": (n) => `for (let ${n} in obj) { console.log(${n}); }`,
    "catch-param": (n) => `try { f(); } catch (${n}) { console.log(${n}); }`,
    "function-param": (n) => `function g(${n}) { return ${n}; }`,
  };
  for (const [label, decl] of Object.entries(forms)) {
    const name = `shadowed_${label.replace(/-/g, "_")}`;
    withRepo({ "probe.mjs": `${prelude(name)}\n${decl(name)}\n` }, (dir) => {
      const r = runGate(dir);
      assert.ok(
        r.output.includes(`'${name}' shadows an import`),
        `${label}: gate should flag shadowing, got: ${r.output}`,
      );
    });
  }
});

test("M-52: gate does not flag alias-source positions or default-value references", () => {
  const name = "clean_name_check";
  const body =
    `${prelude(name)}\n` +
    `const { ${name}: alias } = obj;\n` + // name is a key, alias is the binding
    `function h(a = ${name}) { return a; }\n` + // name is a default value, not a param
    `function unit(t, { staleAfterMs = ${name} } = {}) { return staleAfterMs; }\n` +
    `console.log(alias, h, unit);\n`;
  withRepo({ "probe.mjs": body }, (dir) => {
    const r = runGate(dir);
    assert.equal(r.output.trim(), "no shadowed imports", `unexpected flag: ${r.output}`);
  });
});

test("M-52: gate still ignores unused imports and import-line uses", () => {
  const body =
    `import { join, dirname } from "node:path";\n` +
    `import {\n  sep,\n  delimiter,\n} from "node:path";\n` +
    `console.log(join, dirname, sep, delimiter);\n`;
  withRepo({ "probe.mjs": body }, (dir) => {
    const r = runGate(dir);
    assert.equal(r.output.trim(), "no shadowed imports", `unexpected flag: ${r.output}`);
  });
});
