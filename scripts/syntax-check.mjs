import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse } from "acorn";

// In-process syntax check (PERF-50 G-S2).
//
// The previous implementation spawned `node --check` once per file —
// 2,587 process spawns for the tree check.mjs enumerates, measured at
// 293 s in PERF-50 and 650 s on the contended fleet VM at the base of
// this change. This version parses each file in-process with acorn
// (already a devDependency, also used by scripts/package-mac-runtime.mjs),
// which brings the stage into the <15 s class on an uncontended runner
// while keeping the same accept/reject contract:
//
// - Same file set: check.mjs enumerates the paths; nothing here filters.
// - Same source type per file as `node --check`: .mjs is always a
//   module, .cjs is always a script, and .js follows the nearest
//   package.json "type" field, exactly like Node's own resolution.
//   Scripts allow a top-level `return`, matching `node --check` on a
//   CommonJS file (it parses with wrapper semantics).
// - Same errors caught: acorn implements the ECMAScript early-error
//   rules `node --check` enforces (duplicate lexical declarations,
//   duplicate exports, undeclared private fields, duplicate __proto__,
//   invalid regular expressions, strict-mode violations in modules,
//   reserved words, bad escapes, ...). A differential run over the
//   whole tree plus a seeded corpus of broken/edge files showed
//   identical verdicts file-by-file; see tests/syntax-check.test.js
//   for the pinned classes.
// - Failures are reported in the `node --check` shape (path:line, the
//   offending line, a caret, then `SyntaxError: ...`) and the first
//   failure stops the check with status 1, as before.
//
// The `concurrency` and `stdio` options are retained for call-site
// compatibility with the spawning implementation: concurrency is still
// validated (tests pin the RangeError) but no longer bounds a process
// pool, and stdio "ignore"/"pipe" still suppresses the error report.

const typeCache = new Map();

function sourceTypeFor(absolutePath) {
  const extension = extname(absolutePath);
  if (extension === ".mjs") return "module";
  if (extension === ".cjs") return "script";
  // .js (and anything else Node would treat by scope): the nearest
  // package.json is the scope — its "type" decides, and a package.json
  // without "type" means CommonJS (script); the search does not
  // continue past it, matching Node's package-scope rule.
  let directory = dirname(absolutePath);
  const visited = [];
  for (;;) {
    if (typeCache.has(directory)) {
      const cached = typeCache.get(directory);
      for (const seen of visited) typeCache.set(seen, cached);
      return cached;
    }
    visited.push(directory);
    let scopeType = null;
    try {
      const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
      scopeType = manifest.type === "module" ? "module" : "script";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (scopeType) {
      for (const seen of visited) typeCache.set(seen, scopeType);
      return scopeType;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      for (const seen of visited) typeCache.set(seen, "script");
      return "script";
    }
    directory = parent;
  }
}

function reportParseError(absolutePath, source, error, silent) {
  if (silent) return;
  const message = error.message.replace(/ \(\d+:\d+\)$/, "");
  if (error.loc) {
    const lineText = source.split(/\r\n|\r|\n/)[error.loc.line - 1] ?? "";
    console.error(`${absolutePath}:${error.loc.line}`);
    console.error(lineText);
    console.error(`${" ".repeat(error.loc.column)}^`);
    console.error(`SyntaxError: ${message}`);
  } else {
    console.error(`${absolutePath}: SyntaxError: ${message}`);
  }
}

// Returns 0 when the file parses, 1 (after reporting) when it does not.
function checkOne(absolutePath, silent) {
  let source;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    if (!silent) {
      // `node --check` reports a missing file in exactly this shape.
      if (error.code === "ENOENT") console.error(`Error: Cannot find module '${absolutePath}'`);
      else console.error(`Syntax check failed to read ${absolutePath}: ${error.message}`);
    }
    return 1;
  }
  let sourceType;
  try {
    sourceType = sourceTypeFor(absolutePath);
  } catch (error) {
    if (!silent) console.error(`Syntax check failed for ${absolutePath}: ${error.message}`);
    return 1;
  }
  try {
    parse(source, {
      ecmaVersion: "latest",
      sourceType,
      allowHashBang: true,
      // `node --check` accepts a top-level return in CommonJS files.
      allowReturnOutsideFunction: sourceType === "script",
    });
  } catch (error) {
    reportParseError(absolutePath, source, error, silent);
    return 1;
  }
  return 0;
}

export async function checkSyntax(paths, { cwd, concurrency = 4, stdio = "inherit" } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new RangeError("Syntax check concurrency must be an integer from 1 to 4");
  }
  const base = cwd ? resolve(cwd) : process.cwd();
  const silent = stdio === "ignore" || stdio === "pipe";
  for (const path of paths) {
    if (checkOne(resolve(base, path), silent) !== 0) return 1;
  }
  return 0;
}
