#!/usr/bin/env node
// GUILD-06 static arg-parsing audit: flags risky CLI patterns without executing.
// Patterns:
//  A. uncaught usage throw:  throw new Error("Usage: ...") at top level
//  B. raw argv index: process.argv[N] (N>=2) with no length guard in file
//  C. JSON.parse on argv-derived value without try/catch in same function scope
//  D. readFileSync on argv-derived path without existsSync guard
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = join(ROOT, 'scripts');
const slice = readFileSync(join(ROOT, 'guild-script-slice.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);

function collect(dir, rel) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e); const r = rel ? join(rel, e) : e;
    const st = statSync(full);
    if (st.isDirectory()) { if (e !== 'node_modules') out.push(...collect(full, r)); }
    else if (e.endsWith('.mjs')) out.push(r);
  }
  return out;
}
const files = collect(SCRIPTS, '').filter(f => !['room', 'herdr-migrate.mjs', 'runtime-package.mjs'].includes(f.split('/')[0]) && !['room', 'herdr-migrate.mjs', 'runtime-package.mjs'].includes(f));

const findings = [];
for (const f of files) {
  const src = readFileSync(join(SCRIPTS, f), 'utf8');
  const lines = src.split('\n');
  const isTest = /from ["']node:test["']/.test(src);
  const isBrowser = /playwright|chromium\.launch/.test(src);
  const tags = [isTest && 'node-test', isBrowser && 'browser'].filter(Boolean).join(',');
  // A: uncaught usage throw at top level (not inside try, not inside function with catch)
  lines.forEach((l, i) => {
    if (/throw new Error\(["'`]Usage:/.test(l)) {
      const before = lines.slice(Math.max(0, i - 6), i).join('\n');
      const inTry = /try\s*\{[^}]*$/.test(before);
      findings.push({ f, line: i + 1, kind: 'A-usage-throw', tags, note: l.trim().slice(0, 110), guarded: inTry });
    }
  });
  // B: raw process.argv[N] indexing
  const argvIdx = [...src.matchAll(/process\.argv\[(\d+)\]/g)].map(m => Number(m[1]));
  const maxIdx = Math.max(-1, ...argvIdx);
  if (maxIdx >= 2) {
    const hasLenCheck = /process\.argv\.length|argv\.length/.test(src);
    if (!hasLenCheck) findings.push({ f, line: 0, kind: 'B-raw-argv-index', tags, note: `indexes argv[${maxIdx}] with no argv.length guard` });
  }
  // C: JSON.parse of argv-derived value
  if (/JSON\.parse\(\s*(process\.argv|args\[|values\.)/.test(src)) {
    const hasTry = (src.match(/try\s*\{/g) || []).length > 0;
    findings.push({ f, line: 0, kind: 'C-json-parse-argv', tags, note: 'JSON.parse on CLI-derived input', guarded: hasTry });
  }
  // D: readFileSync on argv-derived path without existsSync
  if (/readFileSync\(\s*(filename|args\[|process\.argv|values\.|path)/.test(src) && !/existsSync/.test(src)) {
    findings.push({ f, line: 0, kind: 'D-readfile-no-exists', tags, note: 'readFileSync on CLI path, no existsSync guard in file' });
  }
}
const byKind = {};
for (const x of findings) { byKind[x.kind] = (byKind[x.kind] || 0) + 1; }
console.log('files scanned:', files.length, 'findings:', findings.length, JSON.stringify(byKind));
for (const x of findings.filter(x => x.kind === 'A-usage-throw')) console.log(`${x.kind} ${x.f}:${x.line} [${x.tags}] guarded=${x.guarded} :: ${x.note}`);
console.log('--- B ---');
for (const x of findings.filter(x => x.kind === 'B-raw-argv-index')) console.log(`${x.f} :: ${x.note} [${x.tags}]`);
console.log('--- C (unguarded only) ---');
for (const x of findings.filter(x => x.kind === 'C-json-parse-argv' && !x.guarded)) console.log(`${x.f} :: ${x.note}`);
console.log('--- D ---');
for (const x of findings.filter(x => x.kind === 'D-readfile-no-exists').slice(0, 40)) console.log(`${x.f} :: ${x.note}`);
