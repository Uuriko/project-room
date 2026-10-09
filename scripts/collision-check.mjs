#!/usr/bin/env node
// collision-check.mjs — GUILD-05 (COORD-300) collision avoidance.
//
// Pre-dispatch collision check: given a snapshot of existing claims and ONE
// proposed new claim, report every ancestor/descendant (or identical) overlap.
// This is the offline gate a launcher runs BEFORE dispatching an agent —
// the check the WAVE-1000 22:12 duplicate-launcher never ran.
//
// Report-only and side-effect-free: reads two JSON files, prints a verdict,
// exits nonzero on collision. It never touches live claims, permissions, or
// the room.
//
// Usage:
//   node scripts/collision-check.mjs --claims snapshot.json --new newclaim.json [--pretty]
//   snapshot.json: [{ "id": "...", "holder": "...", "scopes": ["server/"] }]
//   newclaim.json: { "id": "...", "holder": "...", "scopes": ["server/http.mjs"] }
// Exit: 0 = clear (no overlap, safe to dispatch)
//       2 = COLLISION (overlaps found; details on stdout)
//       1 = usage/input error

import { readFileSync } from 'node:fs';
import { normalizeClaims } from './collision-path-normalize.mjs';

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const claimsFile = get('--claims');
  const newFile = get('--new');
  if (!claimsFile || !newFile || args.includes('--help') || args.includes('-h')) {
    console.log(
      'usage: node scripts/collision-check.mjs --claims snapshot.json --new newclaim.json [--pretty]\n' +
        '  Exit 0 = clear, 2 = collision, 1 = usage/input error. No side effects.'
    );
    process.exit(1);
  }
  const pretty = args.includes('--pretty');
  let existing;
  let fresh;
  try {
    existing = JSON.parse(readFileSync(claimsFile, 'utf8'));
    fresh = JSON.parse(readFileSync(newFile, 'utf8'));
  } catch (e) {
    console.error(`input error: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(existing) || typeof fresh !== 'object' || !fresh) {
    console.error('snapshot must be an array; new claim must be an object');
    process.exit(1);
  }
  const report = normalizeClaims([...existing, fresh]);
  const hits = report.pairs.filter((p) => p.a === fresh.id || p.b === fresh.id);
  const collisions = hits.filter((p) => p.verdict !== 'disjoint');
  const verdict = {
    newClaim: fresh.id,
    checkedAgainst: existing.length,
    clear: collisions.length === 0,
    collisions: collisions.map((c) => ({
      with: c.a === fresh.id ? c.b : c.a,
      withHolder: c.a === fresh.id ? c.bHolder : c.aHolder,
      verdict: c.verdict,
      evidence: c.evidence,
    })),
  };
  console.log(pretty ? JSON.stringify(verdict, null, 2) : JSON.stringify(verdict));
  process.exit(collisions.length ? 2 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
