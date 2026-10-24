// Empty-test-body lint (#3681, the #2893 instance shape).
//
// A test that names a covered behaviour but whose callback body is empty or
// contains only comments passes without checking anything: `node --test`
// reports it green and the coverage it promises does not exist. #2893 was
// exactly this — regression sections for M-29/M-30/M-31/M-46 that were bare
// comment banners with no executable test behind the name.
//
// This lint scans test files for test()/it()/describe() calls whose callback
// body, after comments are stripped, contains no code at all, and fails on
// any instance that is not grandfathered below. The grandfather list is
// shrink-only: an entry that no longer matches a hollow body fails the lint
// too, so the list can only ever get shorter. Bodies that contain code but
// no assertion are NOT this lint's shape (they run; whether they assert
// enough is a review question, not a pass-without-checking defect).
//
// Run: node scripts/empty-test-bodies-check.mjs [file ...]
// With no arguments it scans tests/ recursively for *.test.js / *.test.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Grandfathered hollow test bodies, "<repo-relative file>::<test name>".
// Captured 2026-10-24 at main c4c9d39f (#3681 census scan). Shrink-only:
// remove an entry when its body gains real code; never add a new hollow
// test here — write the test instead.
export const GRANDFATHERED = [
];

// Replace comments and string/template literal contents with spaces,
// preserving offsets and newlines, so brace matching and keyword search
// operate on code structure only. Template interpolations are blanked
// with the rest of the literal (a hollow body cannot hide inside one:
// an interpolation is an expression, which is code, and it lives in the
// surrounding statement, not inside a callback-body brace pair we read).
export function skeleton(source) {
  const out = source.split("");
  const blank = (i) => { if (out[i] !== "\n") out[i] = " "; };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") blank(i++);
    } else if (c === "/" && next === "*") {
      blank(i++); blank(i++);
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) blank(i++);
      if (i < source.length) { blank(i++); blank(i++); }
    } else if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      blank(i++);
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") { blank(i++); if (i < source.length) blank(i++); }
        else blank(i++);
      }
      if (i < source.length) blank(i++); // closing quote
    } else {
      i++;
    }
  }
  return out.join("");
}

// Read a quoted string starting at index i in the ORIGINAL source.
// Returns { value, end } or null when index i is not a string start.
function readString(source, i) {
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let value = "";
  i++;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === "\\" && i + 1 < source.length) { value += source[i + 1]; i += 2; }
    else { value += source[i]; i++; }
  }
  return { value, end: i + 1 };
}

function skipWs(source, i) {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

// Index of the closing bracket matching source[openIdx] in the skeleton
// (strings/comments already blanked, so brackets are structural), or -1.
function matchBracket(skel, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < skel.length; i++) {
    if (skel[i] === open) depth++;
    else if (skel[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const CALL_RE = /(?<![\w$.])(test|it|describe)(?:\s*\.\s*(?:skip|only|todo))?\s*\(/g;

// Find every test()/it()/describe() call whose callback body is empty or
// comment-only. Returns [{ name, line }] with 1-based line of the call.
export function findEmptyTestBodies(source) {
  const skel = skeleton(source);
  const found = [];
  for (const m of skel.matchAll(CALL_RE)) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchBracket(skel, openParen, "(", ")");
    if (closeParen < 0) continue;
    // Name: first argument, when it is a string literal in the original.
    const nameAt = skipWs(source, openParen + 1);
    const nameTok = readString(source, nameAt);
    if (!nameTok) continue; // dynamically named — not a named behaviour
    // Callback: a `function` keyword or `=>` inside the call's arguments.
    const args = skel.slice(openParen + 1, closeParen);
    const fnAt = args.search(/\bfunction\b|=>/);
    if (fnAt < 0) continue; // no inline callback (e.g. test.todo) — nothing hollow to run
    const bodyOpen = args.indexOf("{", fnAt);
    if (bodyOpen < 0) continue; // expression-bodied arrow: the expression is code
    const absBodyOpen = openParen + 1 + bodyOpen;
    const bodyClose = matchBracket(skel, absBodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const body = skel.slice(absBodyOpen + 1, bodyClose);
    if (body.trim() !== "") continue; // contains code — not this lint's shape
    const line = source.slice(0, m.index).split("\n").length;
    found.push({ name: nameTok.value, line });
  }
  return found;
}

// Pure evaluation over [{ file, source }] against a grandfather list.
// Returns { hollow, unlisted, stale } — unlisted and stale are failures.
export function evaluate(files, grandfathered = GRANDFATHERED) {
  const allowed = new Set(grandfathered);
  const seen = new Set();
  const hollow = [];
  for (const { file, source } of files) {
    for (const hit of findEmptyTestBodies(source)) {
      const key = `${file}::${hit.name}`;
      hollow.push({ file, name: hit.name, line: hit.line, key });
      seen.add(key);
    }
  }
  const unlisted = hollow.filter(h => !allowed.has(h.key));
  const stale = [...allowed].filter(key => !seen.has(key));
  return { hollow, unlisted, stale };
}

function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (/\.test\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

export function main(argv) {
  const args = argv.filter(a => a !== "--");
  const paths = args.length > 0
    ? args.map(a => resolve(a))
    : collectTestFiles(join(root, "tests"));
  const files = paths.map(p => ({
    file: relative(root, p).split(sep).join("/"),
    source: readFileSync(p, "utf8"),
  }));
  const { unlisted, stale } = evaluate(files);
  let failed = false;
  for (const h of unlisted) {
    console.error(`empty-test-body: ${h.file}:${h.line} — test "${h.name}" has an empty or comment-only body and checks nothing (#3681; write the test, or grandfather it in scripts/empty-test-bodies-check.mjs with a reason)`);
    failed = true;
  }
  for (const key of stale) {
    console.error(`empty-test-body: grandfathered entry no longer matches a hollow body, remove it (shrink-only): ${key}`);
    failed = true;
  }
  if (failed) return 1;
  console.log(`empty-test-body: OK (${files.length} test files, no unlisted hollow bodies)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
