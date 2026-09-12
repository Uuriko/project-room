// CI gate: no const/let may shadow an imported name when the import is used
// earlier in the file. That pattern is a runtime TDZ ReferenceError that
// `node --check` cannot see (it broke the browser job on main in
// scripts/room-door-browser-check.mjs: the `join` locator shadowed the
// node:path import used above it). Deliberately strict: rename the local.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function files(path) {
  return readdirSync(path, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? files(join(path, e.name)) : /\.(mjs|js)$/.test(e.name) ? [join(path, e.name)] : []);
}

const roots = ["server.mjs", "src", "server", "client", "scripts", "tests",
  ...readdirSync("cloudflare", { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".mjs")).map(e => join("cloudflare", e.name))];

const stripStrings = line => line.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "");
const failures = [];

for (const file of roots.flatMap(r => { try { return files(r); } catch { return [r]; } })) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  const imported = new Set();
  for (const m of src.matchAll(/import\s+(?:[\w$]+\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|([\w$]+))\s*from/g)) {
    if (m[1]) for (const part of m[1].split(",")) {
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[\w$]+$/.test(nm)) imported.add(nm);
    }
    if (m[2]) imported.add(m[2]);
    if (m[3]) imported.add(m[3]);
  }
  if (!imported.size) continue;
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n");
  for (const name of imported) {
    const declRe = new RegExp(`^\\s*(?:const|let)\\s+${name}\\s*=`);
    const useRe = new RegExp(`(^|[^\\w$.])${name}([^\\w$]|$)`);
    const declLines = [];
    lines.forEach((l, i) => { if (declRe.test(l)) declLines.push(i + 1); });
    for (const declLine of declLines) {
      for (let i = 0; i < declLine - 1; i++) {
        const code = stripStrings(lines[i]);
        if (/^\s*import\b/.test(code) || declRe.test(code)) continue;
        if (useRe.test(code)) {
          failures.push(`${file}:${declLine}: '${name}' shadows an import used earlier at line ${i + 1} (TDZ hazard)`);
          break;
        }
      }
    }
  }
}

if (failures.length) {
  console.error("shadowed imports (rename the local):\n" + failures.join("\n"));
  process.exit(1);
}
console.log("no shadowed imports");
