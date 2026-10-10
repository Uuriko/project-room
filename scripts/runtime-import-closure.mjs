// Static import-closure analyzer for the runtime-package allowlist lint.
// Computes the transitive closure of relative ES-module imports starting from
// an entrypoint, so tests can assert every imported module is allowlisted
// without humans hand-maintaining a file list.
//
// Coverage (2026-10-07 hardening): static `import`/`export ... from` with
// relative specifiers (./ or ../), bare `import "./x"`, dynamic `import()`
// with a static string or plain template literal, CommonJS `require("./x")`
// module loads, and `import ... with { type: "json" }` JSON modules.
// `node:` builtins, bare package specifiers, and imports that escape the
// repository root are ignored: the server tree uses static relative imports
// with explicit extensions throughout.
//
// Two finding classes are NEVER silent:
//   - opaque dynamic imports: `import(expr)` where the specifier is not a
//     static string (template with ${}, a call, a variable). The analyzer
//     cannot resolve them, so they are reported for human review instead
//     of being dropped.
//   - unresolvable relative imports: a relative specifier (with or without
//     a recognized extension) that resolves inside the repo but names no
//     file. The old analyzer skipped these silently; a module that fails
//     to resolve at boot is a packaging bug, not an ignorable edge.
// Assertion-style `require(cond)` calls, prose mentions of `import()`,
// and `import.meta` are not module imports and produce no findings.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const MODULE_EXTENSIONS = /\.(mjs|js|cjs|json)$/;

function isWordChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 36 || code === 95;
}

function isWordStart(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 36 || code === 95;
}

// Skip whitespace and // ... / * ... * / comments from index i.
function skipTrivia(source, i) {
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    break;
  }
  return i;
}

// Read a '...' or "..." string starting at i (source[i] is the quote).
// Returns { value, end } or null when unterminated.
function readQuoted(source, i) {
  const quote = source[i];
  const n = source.length;
  let value = "";
  let j = i + 1;
  while (j < n) {
    const c = source[j];
    if (c === "\\") { value += source[j + 1] ?? ""; j += 2; continue; }
    if (c === quote) return { value, end: j + 1 };
    value += c;
    j++;
  }
  return null;
}

// Read a `...` template starting at i (source[i] is the backtick).
// Returns { value, hasExpression, raw, end } or null when unterminated.
// Nested ${ ... } expressions are skipped (balanced), never interpreted.
function readTemplate(source, i) {
  const n = source.length;
  let value = "";
  let hasExpression = false;
  let j = i + 1;
  while (j < n) {
    const c = source[j];
    if (c === "\\") { value += source[j + 1] ?? ""; j += 2; continue; }
    if (c === "`") return { value, hasExpression, raw: source.slice(i, j + 1), end: j + 1 };
    if (c === "$" && source[j + 1] === "{") {
      hasExpression = true;
      j += 2;
      let depth = 1;
      while (j < n && depth > 0) {
        const d = source[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "'" || d === "\"") { const s = readQuoted(source, j); j = s ? s.end : j + 1; continue; }
        if (d === "`") { const t = readTemplate(source, j); j = t ? t.end : j + 1; continue; }
        if (d === "/" && source[j + 1] === "/") { const e = source.indexOf("\n", j + 2); j = e === -1 ? n : e + 1; continue; }
        if (d === "/" && source[j + 1] === "*") { const e = source.indexOf("*/", j + 2); j = e === -1 ? n : e + 2; continue; }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        j++;
      }
      continue;
    }
    value += c;
    j++;
  }
  return null;
}

// Read a balanced (...) / [...] / {...} group starting at i (source[i] is
// the opener). Strings, templates and comments inside are skipped.
function readBalanced(source, i, opener, closer) {
  const n = source.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = source[j];
    if (c === "'" || c === "\"") { const s = readQuoted(source, j); j = s ? s.end : j + 1; continue; }
    if (c === "`") { const t = readTemplate(source, j); j = t ? t.end : j + 1; continue; }
    if (c === "/" && (source[j + 1] === "/" || source[j + 1] === "*")) { j = skipTrivia(source, j); continue; }
    if (c === opener) depth++;
    else if (c === closer) { depth--; if (depth === 0) return { raw: source.slice(i, j + 1), end: j + 1 }; }
    else if ((c === "(" || c === "[" || c === "{") && c !== opener) {
      const closerFor = c === "(" ? ")" : c === "[" ? "]" : "}";
      const inner = readBalanced(source, j, c, closerFor);
      j = inner ? inner.end : j + 1;
      continue;
    }
    j++;
  }
  return null;
}

function readWord(source, i) {
  let j = i;
  while (j < source.length && isWordChar(source.charCodeAt(j))) j++;
  return { word: source.slice(i, j), end: j };
}

// After the `import` keyword (i points just past it): classify the import.
// Returns { kind: "dynamic", literal?, expression?, opaque?, end } |
//         { kind: "meta", end } |
//         { kind: "static", spec?, end }   (spec absent = no specifier found)
function parseImport(source, i) {
  const n = source.length;
  let k = skipTrivia(source, i);
  if (k >= n) return { kind: "static", end: k };
  const c = source[k];
  if (c === ".") return { kind: "meta", end: k + 1 }; // import.meta
  if (c === "(") {
    const paren = k;
    k = skipTrivia(source, k + 1);
    if (k < n && (source[k] === "\"" || source[k] === "'")) {
      const s = readQuoted(source, k);
      if (!s) return { kind: "dynamic", opaque: true, expression: "(unterminated)", end: n };
      return { kind: "dynamic", literal: s.value, end: s.end };
    }
    if (k < n && source[k] === "`") {
      const t = readTemplate(source, k);
      if (!t) return { kind: "dynamic", opaque: true, expression: "(unterminated template)", end: n };
      if (t.hasExpression) return { kind: "dynamic", opaque: true, expression: t.raw, end: t.end };
      return { kind: "dynamic", literal: t.value, end: t.end };
    }
    if (k < n && source[k] === ")") return { kind: "dynamic", end: k + 1 }; // import() — no specifier
    const g = readBalanced(source, paren, "(", ")");
    const expr = g ? g.raw.slice(1, -1).trim() : source.slice(k, k + 40);
    return { kind: "dynamic", opaque: true, expression: expr, end: g ? g.end : n };
  }
  if (c === "\"" || c === "'") {
    const s = readQuoted(source, k); // bare: import "./x";
    return { kind: "static", spec: s ? s.value : undefined, end: s ? s.end : n };
  }
  // Static clause: find the `from` keyword followed by a string, bounded by ;
  let j = k;
  while (j < n) {
    j = skipTrivia(source, j);
    if (j >= n) break;
    const d = source[j];
    if (d === ";") return { kind: "static", end: j + 1 };
    if (d === "'" || d === "\"") { const s = readQuoted(source, j); j = s ? s.end : n; continue; }
    if (d === "`") { const t = readTemplate(source, j); j = t ? t.end : n; continue; }
    if (d === "/" ) { j = skipTrivia(source, j); continue; }
    if (isWordStart(source.charCodeAt(j))) {
      const { word, end } = readWord(source, j);
      if (word === "from") {
        const m = skipTrivia(source, end);
        if (m < n && (source[m] === "\"" || source[m] === "'")) {
          const s = readQuoted(source, m);
          return { kind: "static", spec: s ? s.value : undefined, end: s ? s.end : n };
        }
        j = end;
        continue;
      }
      // A new import/export statement starting means this one had no
      // specifier (defensive; static imports without from are invalid).
      if ((word === "import" || word === "export") && end > k + 1) return { kind: "static", end: j };
      j = end;
      continue;
    }
    j++;
  }
  return { kind: "static", end: j };
}

// After the `export` keyword (i points just past it): only
// `export * [as ns] from "spec"` and `export { ... } from "spec"` carry
// a specifier. Returns { spec?, end }.
function parseExport(source, i) {
  const n = source.length;
  let k = skipTrivia(source, i);
  if (k >= n) return { end: k };
  if (source[k] === "*") {
    k = skipTrivia(source, k + 1);
    if (source.startsWith("as", k) && !isWordChar(source.charCodeAt(k + 2))) {
      const { end } = readWord(source, k + 2);
      k = skipTrivia(source, end);
    }
  } else if (source[k] === "{") {
    const g = readBalanced(source, k, "{", "}");
    k = g ? skipTrivia(source, g.end) : n;
  } else {
    return { end: k }; // export const/let/function/class/default — no specifier
  }
  if (source.startsWith("from", k) && !isWordChar(source.charCodeAt(k + 4))) {
    const m = skipTrivia(source, k + 4);
    if (m < n && (source[m] === "\"" || source[m] === "'")) {
      const s = readQuoted(source, m);
      return { spec: s ? s.value : undefined, end: s ? s.end : n };
    }
  }
  return { end: k };
}

/**
 * Scan one module's source for module imports.
 * Returns { relative: string[], opaqueDynamic: string[] }:
 *  - relative: relative specifiers (./ or ../) from static imports,
 *    export-from, bare imports, dynamic import("...") literals (including
 *    plain template literals), and require("...") module loads.
 *  - opaqueDynamic: raw specifier text of dynamic import() calls the
 *    analyzer cannot resolve statically (expressions, ${} templates).
 * Prose, comments, strings, import.meta, and assertion-style require()
 * never produce findings.
 */
export function scanSourceImports(source) {
  const relative = [];
  const opaqueDynamic = [];
  const n = source.length;
  let i = 0;
  const pushRelative = spec => {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !relative.includes(spec)) relative.push(spec);
  };
  while (i < n) {
    const c = source[i];
    if (c === "'" || c === "\"") { const s = readQuoted(source, i); i = s ? s.end : n; continue; }
    if (c === "`") { const t = readTemplate(source, i); i = t ? t.end : n; continue; }
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) { i = skipTrivia(source, i); continue; }
    if (isWordStart(source.charCodeAt(i))) {
      const { word, end } = readWord(source, i);
      const precededByDot = i > 0 && source[i - 1] === ".";
      if (!precededByDot && (word === "import" || word === "export" || word === "require")) {
        if (word === "import") {
          const parsed = parseImport(source, end);
          if (parsed.kind === "dynamic") {
            if (parsed.literal !== undefined) pushRelative(parsed.literal);
            else if (parsed.opaque) opaqueDynamic.push(parsed.expression ?? "(dynamic import)");
          } else if (parsed.kind === "static" && parsed.spec !== undefined) {
            pushRelative(parsed.spec);
          }
          i = parsed.end;
          continue;
        }
        if (word === "export") {
          const parsed = parseExport(source, end);
          if (parsed.spec !== undefined) pushRelative(parsed.spec);
          i = parsed.end;
          continue;
        }
        // require: module load only when the single argument is a string literal.
        let k = skipTrivia(source, end);
        if (source[k] === "(") {
          k = skipTrivia(source, k + 1);
          if (k < n && (source[k] === "\"" || source[k] === "'")) {
            const s = readQuoted(source, k);
            const m = s ? skipTrivia(source, s.end) : n;
            if (s && source[m] === ")") pushRelative(s.value);
            i = s ? m + 1 : n;
          } else {
            i = k; // assertion-style require(...) or other call — not a module load
          }
          continue;
        }
      }
      i = end;
      continue;
    }
    i++;
  }
  return { relative, opaqueDynamic };
}

function pushUnique(list, entry) {
  if (!list.some(e => e.from === entry.from && e.spec === entry.spec)) list.push(entry);
}

/**
 * Full import analysis of the closure rooted at `entry`.
 * Returns { closure, opaque, unresolvable }:
 *  - closure: Set of repo-relative posix paths reachable from entry,
 *    following static, dynamic-literal, require(), and JSON imports.
 *  - opaque: [{ from, spec }] dynamic imports that cannot be resolved
 *    statically — human review required, never silently dropped.
 *  - unresolvable: [{ from, spec }] relative specifiers that name no
 *    file inside the repo (missing module or unrecognized extension).
 */
export function importClosureReport(entry, repositoryRoot) {
  const closure = new Set();
  const opaque = [];
  const unresolvable = [];
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (closure.has(rel)) continue;
    closure.add(rel);
    const abs = join(repositoryRoot, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    let source;
    try { source = readFileSync(abs, "utf8"); }
    catch { continue; }
    const dir = dirname(rel);
    const { relative: specs, opaqueDynamic } = scanSourceImports(source);
    for (const spec of opaqueDynamic) pushUnique(opaque, { from: rel, spec });
    for (const spec of specs) {
      const resolved = normalize(join(dir, spec)).split(sep).join("/");
      if (resolved === ".." || resolved.startsWith("../")) continue; // escapes the repo
      if (!MODULE_EXTENSIONS.test(resolved)) {
        pushUnique(unresolvable, { from: rel, spec });
        continue;
      }
      if (!existsSync(join(repositoryRoot, ...resolved.split("/")))) {
        pushUnique(unresolvable, { from: rel, spec });
        continue;
      }
      if (!closure.has(resolved)) queue.push(resolved);
    }
  }
  // The entry itself is not "imported"; report only its dependencies.
  closure.delete(entry);
  return { closure, opaque, unresolvable };
}

/**
 * Returns the set of repo-relative (posix) paths transitively imported from
 * `entry` (repo-relative posix path, e.g. "server.mjs"), following static
 * and dynamic-literal relative imports, require() module loads, and JSON
 * modules. Same contract as before the 2026-10-07 hardening, minus the
 * silent blind spots — see importClosureReport for the full findings.
 */
export function importClosure(entry, repositoryRoot) {
  return importClosureReport(entry, repositoryRoot).closure;
}
