// Static import-closure analyzer for the runtime-package allowlist lint.
// Computes the transitive closure of relative ES-module imports starting from
// an entrypoint, so tests can assert every imported module is allowlisted
// without humans hand-maintaining a file list.
//
// Only static `import`/`export ... from` with relative specifiers (./ or ../)
// are followed. `node:` builtins, bare package specifiers, and dynamic
// `import()` are ignored: the server tree uses static relative imports with
// explicit extensions throughout.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const IMPORT_RE = /(?:import\s+(?:[^"']*?\s+from\s+)?|export\s+(?:[^"']*?\s+from\s+)?)(["'])(\.[^"']*)\1/g;

function relativeImports(source) {
  const specs = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const spec = match[2];
    if (spec.startsWith("./") || spec.startsWith("../")) specs.push(spec);
  }
  return specs;
}

/**
 * Returns the set of repo-relative (posix) paths transitively imported from
 * `entry` (repo-relative posix path, e.g. "server.mjs"), following only
 * relative static imports between .mjs/.js/.cjs files that exist on disk.
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
      if (!/\.(mjs|js|cjs)$/.test(resolved)) continue;
      if (resolved === ".." || resolved.startsWith("../")) continue; // escapes the repo
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  // The entry itself is not "imported"; report only its dependencies.
  seen.delete(entry);
  return seen;
}
