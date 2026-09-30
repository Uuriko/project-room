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
  // Strip block comments at file level; per line, strip strings then `//`
  // comments so prose mentioning an import (e.g. `functions (parseDiff, …)`)
  // is never read as a declaration or a use.
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => stripStrings(l).replace(/\/\/.*$/, ""));
  // Declaration forms that introduce a binding for `name`. The gate used to
  // match only line-leading `const name =` / `let name =`, so destructuring,
  // multi-declarator, for-of, catch params, `var`, and function params all
  // slipped through — every one of them is the same TDZ hazard.
  //
  // For const/let/var lines we split the declarator list on top-level commas
  // (depth-aware, so `const x = f(a, NAME)` is NOT a declaration of NAME —
  // a bare regex cannot tell a declarator comma from a call-argument comma).
  const splitDeclarators = (rest) => {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of rest) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    return parts;
  };
  const bindingRes = (name) => [
    new RegExp(`^\\s*${name}\\s*(?:=|;|$)`), // plain / multi-declarator: NAME = ...
    // Object/array destructuring where `name` is the local binding.
    // `(?!\s*:)` excludes the alias-source position (`{name: alias}`,
    // `const {name: mk} = await import(...)`) — there `name` is a key, not a binding.
    new RegExp(`^\\s*\\{[^}]*\\b${name}\\b(?!\\s*:)`),
    new RegExp(`^\\s*\\[[^\\]]*\\b${name}\\b(?!\\s*:)`),
  ];
  const otherDeclRes = (name) => [
    new RegExp(`^\\s*for\\s*\\(\\s*(?:const|let|var)?\\s*${name}\\s+(?:of|in)\\b`), // for (name of
    new RegExp(`\\bcatch\\s*\\(\\s*${name}\\s*\\)`),                    // catch (name)
  ];
  // Function params: `name` in binding position inside the parameter list —
  // right after (, ,, {, [, :, or ... — but not as another param's default
  // value (`f(a = name)`). A single regex can't reuse the paren it consumed,
  // so extract the param list first, then look for binding positions in it.
  const declaresFunctionParam = (line, name) => {
    const pm = line.match(/\bfunction(?![\w$])\s*[\w$]*\s*\(([^)]*)\)/);
    return !!pm && new RegExp(`(?:^|[(,{\\[:]|\\.\\.\\.)\\s*\\b${name}\\b`).test(pm[1]);
  };
  const declaresOnLine = (line, name) => {
    const m = line.match(/^\s*(?:const|let|var)\s+(.*?);?\s*$/);
    if (m && splitDeclarators(m[1]).some((d) => bindingRes(name).some((re) => re.test(d)))) return true;
    if (declaresFunctionParam(line, name)) return true;
    return otherDeclRes(name).some((re) => re.test(line));
  };
  for (const name of imported) {
    const useRe = new RegExp(`(^|[^\\w$.])${name}([^\\w$]|$)`);
    const declLines = [];
    lines.forEach((l, i) => { if (declaresOnLine(l, name)) declLines.push(i + 1); });
    for (const declLine of declLines) {
      for (let i = 0; i < declLine - 1; i++) {
        const code = stripStrings(lines[i]);
        if (/^\s*import\b/.test(code) || declaresOnLine(code, name)) continue;
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
