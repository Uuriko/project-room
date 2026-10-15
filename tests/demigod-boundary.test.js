// Extension-boundary guard for decision #13 (E6): the Demigod placement
// cluster is PARKED behind an in-repo boundary. The cluster today is the
// record-rails modules — demigod offers/contracts, trial tasks, buyer
// signoffs, vetting receipts, and their fee/settlement helpers. Census at
// a594cbd48: the only core touchpoints are server/store.mjs (constructs
// the four stores, execs their schemas) and server/routes/table.mjs
// (mounts the cluster's route table). This test walks the production
// import graph (server/, src/) and fails if any other core module grows
// an import of a cluster module — the park stays real only while the
// core cannot quietly depend on the placement business again.
// Lifecycle modules (account deletion, purge, writer fence) reference
// cluster TABLES by name for deletion/fencing; that is the data
// lifecycle contract, not a module dependency, and is out of scope here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CLUSTER = new Set([
  'server/demigod-offers.mjs',
  'server/demigod-contracts.mjs',
  'server/demigod-policy-adapter.mjs',
  'server/trial-tasks.mjs',
  'server/trial-task-store.mjs',
  'server/buyer-signoff.mjs',
  'server/vetting-receipts.mjs',
  'server/fee-credit-ledger.mjs',
  'server/settlement-router.mjs',
  'server/routes/record-rails.mjs',
]);

// The entire sanctioned core -> cluster surface. Adding an entry here is
// a boundary decision: it belongs in the PR description, not in passing.
const ALLOWED_IMPORTERS = new Map([
  ['server/store.mjs', new Set([
    'server/demigod-offers.mjs', 'server/demigod-contracts.mjs',
    'server/buyer-signoff.mjs', 'server/trial-task-store.mjs',
  ])],
  ['server/routes/table.mjs', new Set(['server/routes/record-rails.mjs'])],
]);

function* productionFiles(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* productionFiles(rel);
    else if (/\.(mjs|js)$/.test(entry.name)) yield rel;
  }
}

function importsOf(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const found = new Set();
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = resolve(dirname(join(ROOT, rel)), match[1]).slice(ROOT.length + 1);
    found.add(target);
  }
  return found;
}

test('core modules do not import the Demigod cluster outside the boundary', () => {
  const violations = [];
  for (const dir of ['server', 'src']) {
    for (const rel of productionFiles(dir)) {
      if (CLUSTER.has(rel)) continue; // intra-cluster imports are the cluster's own business
      for (const target of importsOf(rel)) {
        if (!CLUSTER.has(target)) continue;
        const allowed = ALLOWED_IMPORTERS.get(rel);
        if (!allowed || !allowed.has(target)) violations.push(`${rel} -> ${target}`);
      }
    }
  }
  assert.deepEqual(violations, [], `Demigod boundary crossed (decision #13 park):\n${violations.join('\n')}`);
});

test('the boundary surface is exactly the store wiring and the route mount', () => {
  // Pin the allowed surface itself: if store.mjs starts importing a
  // cluster helper directly (bypassing the four stores), this fails even
  // though the import is "allowed" by file.
  for (const [importer, targets] of ALLOWED_IMPORTERS) {
    const actual = [...importsOf(importer)].filter((target) => CLUSTER.has(target)).sort();
    assert.deepEqual(actual, [...targets].sort(), `${importer} cluster imports drifted from the boundary`);
  }
});
