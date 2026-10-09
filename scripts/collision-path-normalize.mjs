#!/usr/bin/env node
// collision-path-normalize.mjs — GUILD-05 (COORD-300) collision avoidance.
//
// Normalizes claim path-scopes and classifies ancestor/descendant overlaps
// between claims. Pure + offline: no network, no live state, no writes.
//
// A claim scope is a repo-relative path. Trailing slash means DIRECTORY
// (recursive: covers the dir itself and everything beneath it). No trailing
// slash means FILE (covers exactly that path).
//
// Observed failure modes this addresses:
//  - Two legs running the same owed list: identical scopes filed twice.
//  - Broad lease vs narrow claim: e.g. `server/` (ancestor) vs
//    `server/http.mjs` (descendant) — naive equality checks miss it.
//  - Substring false positives: `server/` must NOT match `serverless/`.
//  - Unnormalized input: `./server//http.mjs` must equal `server/http.mjs`.
//
// Usage:
//   node scripts/collision-path-normalize.mjs --claims claims.json [--pretty]
//   claims.json: [{ "id": "replay18", "holder": "lane-a", "scopes": ["agent-conversations/"] }]
// Output (stdout): JSON overlap report. Exit 0 always (report-only).

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Canonicalize one raw scope string.
 * Returns { path, dir } or null when the input is unusable.
 * Lexical only: no filesystem access, so `..` resolves by popping segments.
 */
export function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Directory marker = trailing slash on the trimmed input (before splitting).
  const dir = trimmed.endsWith('/');
  // Strip leading ./ and / sequences.
  let s = trimmed.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (!out.length) return null;
  return { path: out.join('/'), dir };
}

/**
 * Does scope `a` (normalized) cover scope `b` (normalized)?
 * Coverage sets: dir scope covers itself + everything beneath it (segment
 * boundary required); file scope covers exactly its own path. A file scope
 * and a dir scope at the SAME location are treated as covering each other
 * (conservative: a claim on `docs` and a claim on `docs/` collide).
 */
export function covers(a, b) {
  if (!a || !b) return false;
  if (a.path === b.path) return true; // identical location, either kind
  if (a.dir && b.path.startsWith(a.path + '/')) return true;
  return false;
}

/**
 * Relationship of scope a to scope b: 'identical' | 'a-covers-b' |
 * 'b-covers-a' | 'disjoint'.
 */
export function scopeRelation(a, b) {
  const ab = covers(a, b);
  const ba = covers(b, a);
  if (ab && ba) return 'identical';
  if (ab) return 'a-covers-b';
  if (ba) return 'b-covers-a';
  return 'disjoint';
}

// ---------------------------------------------------------------------------
// Claim-pair classification
// ---------------------------------------------------------------------------

/**
 * Classify the overlap between two claims' scope sets.
 * Returns { verdict, evidence } where verdict is one of:
 *   disjoint | identical | a-contains-b | b-contains-a | partial
 * and evidence lists every overlapping scope pair with its relation.
 */
export function classifyPair(aScopes, bScopes) {
  const A = aScopes.map(normalizePath).filter(Boolean);
  const B = bScopes.map(normalizePath).filter(Boolean);
  const evidence = [];
  for (const a of A) {
    for (const b of B) {
      const relation = scopeRelation(a, b);
      if (relation !== 'disjoint') {
        evidence.push({
          aScope: a.dir ? a.path + '/' : a.path,
          bScope: b.dir ? b.path + '/' : b.path,
          relation,
        });
      }
    }
  }
  if (!evidence.length) return { verdict: 'disjoint', evidence };

  // Coverage direction: is every scope on one side covered by the other side?
  const bCoveredByA = B.every((b) => A.some((a) => covers(a, b)));
  const aCoveredByB = A.every((a) => B.some((b) => covers(b, a)));
  // Strictness: at least one strict (non-identical) cover in the direction.
  const strictAB = evidence.some((e) => e.relation === 'a-covers-b');
  const strictBA = evidence.some((e) => e.relation === 'b-covers-a');

  let verdict;
  if (bCoveredByA && aCoveredByB && !strictAB && !strictBA) verdict = 'identical';
  else if (bCoveredByA && strictAB) verdict = 'a-contains-b';
  else if (aCoveredByB && strictBA) verdict = 'b-contains-a';
  else verdict = 'partial';
  return { verdict, evidence };
}

/**
 * Normalize a whole claim set into a pairwise overlap graph.
 * claims: [{ id, holder?, scopes: [raw...] }]. Self-pairs are skipped
 * (a claim never collides with itself). Pairs are unordered (i < j).
 */
export function normalizeClaims(claims) {
  const pairs = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      const { verdict, evidence } = classifyPair(a.scopes ?? [], b.scopes ?? []);
      pairs.push({
        a: a.id,
        b: b.id,
        aHolder: a.holder ?? null,
        bHolder: b.holder ?? null,
        verdict,
        evidence,
      });
    }
  }
  const overlapping = pairs.filter((p) => p.verdict !== 'disjoint');
  return {
    claims: claims.length,
    pairCount: pairs.length,
    overlapping: overlapping.length,
    pairs: pairs,
    summary: {
      identical: pairs.filter((p) => p.verdict === 'identical').length,
      contained: pairs.filter((p) => p.verdict === 'a-contains-b' || p.verdict === 'b-contains-a').length,
      partial: pairs.filter((p) => p.verdict === 'partial').length,
      disjoint: pairs.filter((p) => p.verdict === 'disjoint').length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const file = get('--claims');
  if (!file || args.includes('--help') || args.includes('-h')) {
    console.log(
      'usage: node scripts/collision-path-normalize.mjs --claims claims.json [--pretty]\n' +
        '  claims.json: [{ "id": "...", "holder": "...", "scopes": ["server/", "docs/api/"] }]\n' +
        '  Prints a JSON overlap report to stdout. Report-only: exit 0, no side effects.'
    );
    process.exit(file ? 0 : 1);
  }
  const pretty = args.includes('--pretty');
  let claims;
  try {
    claims = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read/parse ${file}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(claims)) {
    console.error('claims file must be a JSON array');
    process.exit(1);
  }
  const report = normalizeClaims(claims);
  console.log(pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
