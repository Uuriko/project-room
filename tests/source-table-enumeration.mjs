// Source-DDL table enumeration, shared by the coverage tests
// (purge-source-coverage, retention-source-coverage). Both registries —
// server/purge-registry.mjs and server/retention-registry.mjs — must
// disposition the same enumerated set, so the enumeration itself lives in
// exactly one place: if the DDL patterns or the walker ever change, both
// coverage suites move together and cannot silently diverge.
//
// Enumerates every table declared in server/** source — including lazily
// created additive tables and tables whose DDL names them through a
// same-file const. A real DDL statement names the table and opens its
// column list; requiring the "(" keeps comment prose ("the CREATE TABLE
// above") and regex literals from enumerating phantom tables. DDL that
// names its table through an interpolated const must resolve to a string
// literal in the same file; an unresolvable one is an enumeration failure,
// never a silent skip.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const STRICT_DDL = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(["'`\[]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(/g;
const DYNAMIC_DDL = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g;

export function enumerateSourceTables(repoRoot) {
  const serverDir = join(repoRoot, "server");
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  })(serverDir);
  const tables = new Map(); // name -> [repo-relative files]
  const unresolvable = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(repoRoot, file);
    for (const match of text.matchAll(STRICT_DDL)) {
      if (!tables.has(match[2])) tables.set(match[2], []);
      tables.get(match[2]).push(rel);
    }
    for (const match of text.matchAll(DYNAMIC_DDL)) {
      const ident = match[1];
      const constPattern = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*=\\s*['"\`]([A-Za-z_][A-Za-z0-9_]*)['"\`]`);
      const resolved = constPattern.exec(text);
      if (!resolved) {
        unresolvable.push(`${rel}: a DDL statement names its table through \${${ident}}, which does not resolve to a string-literal const in the same file`);
        continue;
      }
      if (!tables.has(resolved[1])) tables.set(resolved[1], []);
      tables.get(resolved[1]).push(`${rel} (dynamic \${${ident}})`);
    }
  }
  return { tables, unresolvable };
}
