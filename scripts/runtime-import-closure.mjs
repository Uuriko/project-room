// Static import-closure analyzer for the runtime-package allowlist lint.
// Computes the transitive closure of relative ES-module imports starting from
// an entrypoint, so tests can assert every imported module is allowlisted
// without humans hand-maintaining a file list.
//
// Only static `import`/`export ... from` with relative specifiers (./ or ../)
// are followed, plus relative string-literal specifiers in dynamic
// `import("./x.mjs")` calls and JSON module imports
// (`import data from "./x.json" with { type: "json" }`). `node:` builtins,
// bare package specifiers, non-literal dynamic specifiers (variables,
// template literals), and member-call `.import(...)` are ignored: the server
// tree uses static relative imports with explicit extensions throughout, and
// its only dynamic imports are node: builtins (web-fetch, webhook-dispatch).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const IMPORT_RE = /(?:import\s+(?:[^"']*?\s+from\s+)?|export\s+(?:[^"']*?\s+from\s+)?)(["'])(\.[^"']*)\1/g;

// Dynamic import() with a string-literal relative specifier. The lookbehind
// keeps member calls (`loader.import("./x")`) and longer identifiers
// (`reimport("./x")`) out; the required quote keeps variables and template
// literals out (they cannot be resolved statically).
const DYNAMIC_IMPORT_RE = /(?<![\w$.])import\s*\(\s*(["'])(\.[^"']*)\1\s*\)/g;

function relativeImports(source) {
  const specs = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const spec = match[2];
    if (spec.startsWith("./") || spec.startsWith("../")) specs.push(spec);
  }
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((match = DYNAMIC_IMPORT_RE.exec(source)) !== null) {
    const spec = match[2];
    if (spec.startsWith("./") || spec.startsWith("../")) specs.push(spec);
  }
  return specs;
}

/**
 * Returns the set of repo-relative (posix) paths transitively imported from
 * `entry` (repo-relative posix path, e.g. "server.mjs"), following relative
 * static imports, relative string-literal dynamic import() specifiers, and
 * JSON module imports between .mjs/.js/.cjs/.json files that exist on disk.
 */
export function importClosure(entry, repositoryRoot) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(repositoryRoot, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    let source;
    try { source = readFileSync(abs, "utf8"); }
    catch { continue; }
    const dir = dirname(rel);
    for (const spec of relativeImports(source)) {
      const resolved = normalize(join(dir, spec)).split(sep).join("/");
      if (!/\.(mjs|js|cjs|json)$/.test(resolved)) continue;
      if (resolved === ".." || resolved.startsWith("../")) continue; // escapes the repo
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  // The entry itself is not "imported"; report only its dependencies.
  seen.delete(entry);
  return seen;
}
