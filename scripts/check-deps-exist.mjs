// Zero-bug gate: dependency-existence ("slopsquatting" defense).
// Two checks, both fail the workflow on findings:
//
//  (1) Registry existence: every dependency declared in package.json
//      (dependencies + devDependencies + optionalDependencies) must exist
//      on the npm registry. A hallucinated package name (slopsquatting /
//      dependency confusion) fails here. Local specs (file:, link:, ./,
//      git+, github:, http(s):, workspace:) are skipped — they do not
//      resolve through the registry.
//  (2) Declared-imports: every bare import in scanned source files must be
//      a declared dependency (of the nearest package.json), a Node builtin,
//      or a relative path. Catches imports of packages the PR never declared.
//
// Usage: node scripts/check-deps-exist.mjs [--root <dir>]
// Zero-dep (only node: builtins). Network: one packument fetch per declared
// package, 10s timeout each, sequential with a small concurrency pool.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import https from "node:https";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}
const ROOT = resolve(flag("--root") || process.env.ZERO_BUG_ROOT || process.cwd());

const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;

// Registry-less specs: version ranges and npm: aliases are registry specs;
// everything else is skipped for check (1).
function isRegistrySpec(spec) {
  return !/^(file:|link:|\.\.?\/|\/|git\+|github:|https?:|workspace:|catalog:)/.test(spec);
}
// npm:alias@version -> real name for the registry check.
function registryName(name, spec) {
  const m = /^npm:([^@]+)@/.exec(spec);
  return m ? m[1] : name;
}

function packumentExists(name) {
  return new Promise((resolveP) => {
    const url = `${REGISTRY}/${name.split("/").map(encodeURIComponent).join("/")}`;
    const req = https.get(url, { headers: { accept: "application/json" } }, (res) => {
      res.resume();
      resolveP(res.statusCode === 200);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolveP(false));
  });
}

// --- Check (1): every declared dependency resolves on the registry --------
function declaredDeps() {
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    const pkgFile = join(dir, "package.json");
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
        for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
          for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
            const key = `${dir}\0${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ dir, name, spec });
          }
        }
      } catch { /* unreadable package.json: skip */ }
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist" || e.name === "coverage" || e.name === "test-results") continue;
      // Nested packages own their deps: do not merge them upward.
      if (existsSync(join(dir, e.name, "package.json"))) continue;
      walk(join(dir, e.name));
    }
  };
  walk(ROOT);
  return out;
}

async function checkRegistry() {
  const findings = [];
  const deps = declaredDeps().filter((d) => isRegistrySpec(d.spec));
  const pool = [];
  const results = [];
  for (const d of deps) {
    const p = packumentExists(registryName(d.name, d.spec)).then((ok) => ({ d, ok }));
    pool.push(p);
    if (pool.length >= 8) results.push(await pool.shift());
  }
  results.push(...(await Promise.all(pool)));
  for (const { d, ok } of results) {
    if (!ok) findings.push(`registry: ${relative(ROOT, d.dir) || "."}/package.json declares "${d.name}@${d.spec}" — not found on the npm registry`);
  }
  return findings;
}

// --- Check (2): bare imports resolve to a declared dep / builtin / relative -
// String- and comment-aware scan. Comments are removed; string literals are
// kept but their ranges are recorded so an `import`/`require` keyword that
// appears *inside* a string (docs, code samples) is never treated as a real
// import. Only the keyword position is checked — the specifier itself is,
// by definition, a string.
function scanCode(src) {
  let code = "";
  const strings = []; // [start, end) ranges in `code`
  let i = 0;
  const n = src.length;
  // Consumes a string literal starting at src[i] (the quote char). Template
  // interpolations are scanned for balanced braces so nested templates do
  // not corrupt quote state; the whole literal stays one opaque range.
  function scanString(q) {
    const start = code.length;
    code += q;
    i += 1;
    while (i < n) {
      if (src[i] === "\\") { code += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
      if (src[i] === q) { code += q; i += 1; break; }
      if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
        code += "${";
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const ch = src[i];
          if (ch === "`" || ch === "'" || ch === '"') scanString(ch);
          else {
            if (ch === "{") depth += 1;
            else if (ch === "}") depth -= 1;
            code += ch;
            i += 1;
          }
        }
        continue;
      }
      code += src[i];
      i += 1;
    }
    strings.push([start, code.length]);
  }
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i += 1;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
    } else if (c === "'" || c === '"' || c === "`") {
      scanString(c);
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, strings };
}

function inString(strings, idx) {
  for (const [s, e] of strings) if (idx >= s && idx < e) return true;
  return false;
}

const IMPORT_RES = [
  /(?:^|;|\})\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm, // import x from 'm', import 'm'
  /(?:^|;|\})\s*export\s+(?:[^'";]*?\s+from\s+)['"]([^'"]+)['"]/gm, // export ... from 'm'
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // require('m')
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // import('m')
]; // (string contents of specifiers stay visible; the keyword position is validated)

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function topLevelName(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split("/")[0];
}

// Virtual modules provided by non-Node runtimes. npm package names cannot
// contain ":", so a `cloudflare:*` specifier can never be a registry
// package — it is a workerd builtin (cloudflare:workers, cloudflare:node).
function isVirtualModule(spec) {
  return spec.startsWith("cloudflare:");
}

// Declared deps for a file = union of every package.json from the file's
// directory up to the repo root. This mirrors Node's upward node_modules
// resolution: cloudflare/*.check.mjs legitimately resolves `playwright`
// from the root package even though cloudflare/package.json is nearer.
const pkgCache = new Map();
function declaredFor(file) {
  let dir = dirname(file);
  const names = new Set();
  while (true) {
    if (!pkgCache.has(dir)) {
      const pkgNames = new Set();
      const pkgFile = join(dir, "package.json");
      if (existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
          for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
            for (const n of Object.keys(pkg[field] ?? {})) pkgNames.add(n);
          }
        } catch { /* unreadable package.json: skip */ }
      }
      pkgCache.set(dir, pkgNames);
    }
    for (const n of pkgCache.get(dir)) names.add(n);
    if (dir === ROOT) break;
    const parent = dirname(dir);
    if (parent === dir || !dir.startsWith(ROOT)) break;
    dir = parent;
  }
  return names;
}

function* sourceFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // perf/ holds k6 load-test scripts: they run under the k6 binary, not
      // Node, and `k6`/`k6/http` are k6-runtime virtual modules.
      if (["node_modules", "dist", "coverage", "test-results", ".git", ".tmp", ".data", "vendor", "perf"].includes(e.name) || e.name.startsWith(".")) continue;
      yield* sourceFiles(p);
    } else if (/\.(mjs|cjs|js)$/.test(e.name) && !e.name.endsWith(".min.js")) {
      yield p;
    }
  }
}

function checkImports() {
  const findings = [];
  let files = 0;
  for (const file of sourceFiles(ROOT)) {
    files += 1;
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const { code, strings } = scanCode(src);
    const declared = declaredFor(file);
    const seen = new Set();
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        if (inString(strings, m.index)) continue; // keyword inside a string: not a real import
        const spec = m[1];
        if (!spec || seen.has(spec)) continue;
        seen.add(spec);
        if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("data:") || spec.startsWith("file:")) continue;
        if (isVirtualModule(spec)) continue;
        if (BUILTINS.has(spec) || BUILTINS.has(spec.replace(/^node:/, ""))) continue;
        const top = topLevelName(spec);
        if (declared.has(top)) continue;
        findings.push(`import: ${relative(ROOT, file)} imports "${spec}" — not a declared dependency`);
      }
    }
  }
  return { findings, files };
}

async function main() {
  const problems = [];
  const { findings: importFindings, files } = checkImports();
  problems.push(...importFindings);
  problems.push(...(await checkRegistry()));
  if (problems.length === 0) {
    console.log(`check-deps-exist: clean (${files} source files scanned)`);
    return;
  }
  console.error(`check-deps-exist: ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
  if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
  process.exit(1);
}

main().catch((e) => { console.error(`check-deps-exist: fatal: ${e.message}`); process.exit(2); });
