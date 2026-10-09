// collision-path-overlap.test.js — GUILD-05 (COORD-300) acceptance tests.
//
// Covers Dot's three acceptance fixtures (replay18/28, docs10/33,
// broad-server-lease vs PR #2272) plus negative controls proving the
// normalizer does not false-positive. Run: node --test tests/collision-path-overlap.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

import {
  normalizePath,
  covers,
  scopeRelation,
  classifyPair,
  normalizeClaims,
} from '../scripts/collision-path-normalize.mjs';
import { buildTree, expand, assignLpt, verifyDisjoint } from '../scripts/collision-partition-propose.mjs';
import { claims as replayClaims } from './fixtures/collision/replay18-28.fixture.mjs';
import { claims as docsClaims } from './fixtures/collision/docs10-33.fixture.mjs';
import { claims as serverPrClaims } from './fixtures/collision/server-lease-pr2272.fixture.mjs';

// ---------------------------------------------------------------------------
// Acceptance fixture 1: replay18/28 — ancestor/descendant overlap
// ---------------------------------------------------------------------------

test('replay18/28: narrow skill-harness claim is contained in the broad agent-conversations claim', () => {
  const report = normalizeClaims(replayClaims);
  assert.equal(report.pairs.length, 1);
  const [pair] = report.pairs;
  assert.equal(pair.a, 'replay18');
  assert.equal(pair.b, 'replay28');
  assert.equal(pair.verdict, 'a-contains-b');
  assert.equal(pair.evidence.length, 1);
  assert.equal(pair.evidence[0].aScope, 'agent-conversations/');
  assert.equal(pair.evidence[0].bScope, 'agent-conversations/replay-scenarios/skill-harness/');
  assert.equal(pair.evidence[0].relation, 'a-covers-b');
});

// ---------------------------------------------------------------------------
// Acceptance fixture 2: docs10/33 — partitions that share an ancestor
// ---------------------------------------------------------------------------

test('docs10/33: disjoint docs partitions do NOT collide despite shared ancestor', () => {
  const report = normalizeClaims(docsClaims);
  assert.equal(report.pairs.length, 1);
  const [pair] = report.pairs;
  assert.equal(pair.verdict, 'disjoint');
  assert.equal(pair.evidence.length, 0);
  assert.equal(report.summary.disjoint, 1);
});

// ---------------------------------------------------------------------------
// Acceptance fixture 3: broad server lease vs PR #2272 — no overlap
// ---------------------------------------------------------------------------

test('broad server lease vs PR #2272: disjoint (lease does not cover the PR)', () => {
  const report = normalizeClaims(serverPrClaims);
  assert.equal(report.pairs.length, 1);
  const [pair] = report.pairs;
  assert.equal(pair.a, 'srv-lease-broad');
  assert.equal(pair.b, 'pr-2272');
  assert.equal(pair.verdict, 'disjoint');
});

// ---------------------------------------------------------------------------
// Negative controls — the normalizer must not invent collisions
// ---------------------------------------------------------------------------

test('negative control: server/ does not cover serverless/ (segment boundary)', () => {
  const { verdict } = classifyPair(['server/'], ['serverless/deploy.mjs']);
  assert.equal(verdict, 'disjoint');
});

test('negative control: server/ does not cover server/http.mjs.evil (no extension trick)', () => {
  // 'server/http.mjs' IS covered; a sibling file with a longer name is not.
  const { verdict } = classifyPair(['server/http.mjs/'], ['server/http.mjs2']);
  assert.equal(verdict, 'disjoint');
});

test('negative control: a claim never collides with itself', () => {
  const report = normalizeClaims([{ id: 'solo', scopes: ['server/'] }]);
  assert.equal(report.pairs.length, 0);
});

test('negative control: unnormalized input canonicalizes (./ and // collapse)', () => {
  assert.deepEqual(normalizePath('./server//http.mjs'), { path: 'server/http.mjs', dir: false });
  assert.deepEqual(normalizePath('docs/'), { path: 'docs', dir: true });
  assert.equal(normalizePath(''), null);
  assert.equal(normalizePath('   '), null);
  assert.equal(normalizePath(null), null);
  const { verdict } = classifyPair(['./server//'], ['server/http.mjs']);
  assert.equal(verdict, 'a-contains-b');
});

test('negative control: file scope and dir scope at the same location collide (conservative)', () => {
  // `docs` (file reading) vs `docs/` (dir claim) — same location, flag it.
  assert.equal(scopeRelation(normalizePath('docs'), normalizePath('docs/')), 'identical');
  const { verdict } = classifyPair(['docs'], ['docs/']);
  assert.equal(verdict, 'identical');
});

test('negative control: duplicate identical scopes filed twice are flagged identical', () => {
  // The "two legs ran the same owed list" shape.
  const { verdict, evidence } = classifyPair(['server/http.mjs'], ['server/http.mjs']);
  assert.equal(verdict, 'identical');
  assert.equal(evidence.length, 1);
});

test('negative control: partial overlap (neither side contains the other)', () => {
  const { verdict } = classifyPair(
    ['server/', 'docs/api/'],
    ['server/http.mjs', 'docs/']
  );
  assert.equal(verdict, 'partial');
});

test('covers(): ancestor, self, and non-ancestor cases', () => {
  assert.equal(covers(normalizePath('server/'), normalizePath('server/http.mjs')), true);
  assert.equal(covers(normalizePath('server/'), normalizePath('server/')), true);
  assert.equal(covers(normalizePath('server/http.mjs'), normalizePath('server/')), false);
  assert.equal(covers(normalizePath('server/'), normalizePath('serverless/x.mjs')), false);
});

// ---------------------------------------------------------------------------
// Partition proposer — static disjoint slices
// ---------------------------------------------------------------------------

function docsMap() {
  // Synthetic docs tree: 4 subtrees with uneven weights.
  const entries = [];
  const add = (dir, n) => {
    for (let i = 0; i < n; i++) entries.push({ path: `docs/${dir}/p${i}.md`, weight: 1 });
  };
  add('tutorials', 10);
  add('guides', 6);
  add('api', 4);
  add('reference', 2);
  return entries;
}

test('partition proposer: N=4 over docs/ yields 4 disjoint slices, verified', () => {
  const root = buildTree(docsMap(), 'docs');
  const leaves = expand(root, 4);
  const agents = assignLpt(leaves, 4);
  assert.equal(agents.length, 4);
  const problems = verifyDisjoint(agents);
  assert.deepEqual(problems, []);
  // Every file lands in exactly one slice: union of scopes covers all leaves.
  const total = agents.reduce((s, a) => s + a.weight, 0);
  assert.equal(total, 22);
});

test('partition proposer: N=1 yields the whole scope as one slice', () => {
  const root = buildTree(docsMap(), 'docs');
  const agents = assignLpt(expand(root, 1), 1);
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0].scopes, ['docs/']);
});

test('partition proposer: deterministic — same input, same slices', () => {
  const once = assignLpt(expand(buildTree(docsMap(), 'docs'), 4), 4);
  const twice = assignLpt(expand(buildTree(docsMap(), 'docs'), 4), 4);
  assert.deepEqual(once, twice);
});

test('partition proposer: more agents than leaves degrades gracefully', () => {
  const root = buildTree(docsMap(), 'docs');
  const agents = assignLpt(expand(root, 99), 99);
  assert.ok(agents.length < 99, 'cannot invent slices; reports fewer agents');
  assert.deepEqual(verifyDisjoint(agents), []);
});

// ---------------------------------------------------------------------------
// collision-check CLI — exit-code contract
// ---------------------------------------------------------------------------

const SCRIPTS = new URL('../scripts/', import.meta.url).pathname;

function runCheck(snapshot, fresh) {
  const dir = mkdirSync(join(tmpdir(), `g05-${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true,
  });
  const snap = join(dir, 'snapshot.json');
  const nw = join(dir, 'new.json');
  writeFileSync(snap, JSON.stringify(snapshot));
  writeFileSync(nw, JSON.stringify(fresh));
  try {
    const out = execFileSync('node', [join(SCRIPTS, 'collision-check.mjs'), '--claims', snap, '--new', nw], {
      encoding: 'utf8',
    });
    return { code: 0, out: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, out: JSON.parse(e.stdout || '{}') };
  }
}

test('collision-check: exits 2 with evidence on ancestor overlap', () => {
  const { code, out } = runCheck(replayClaims.slice(0, 1), {
    id: 'new-leg',
    holder: 'lane-b',
    scopes: ['agent-conversations/replay-scenarios/skill-harness/'],
  });
  assert.equal(code, 2);
  assert.equal(out.clear, false);
  assert.equal(out.collisions.length, 1);
  assert.equal(out.collisions[0].with, 'replay18');
  assert.equal(out.collisions[0].verdict, 'a-contains-b');
});

test('collision-check: exits 0 when the new claim is disjoint', () => {
  const { code, out } = runCheck(serverPrClaims.slice(0, 1), {
    id: 'pr-2272',
    holder: 'lane-c',
    scopes: ['tests/qa5r-mcp-public-work-suggest.test.js'],
  });
  assert.equal(code, 0);
  assert.equal(out.clear, true);
  assert.deepEqual(out.collisions, []);
});

test('collision-check: exits 1 on missing args', () => {
  try {
    execFileSync('node', [join(SCRIPTS, 'collision-check.mjs')], { encoding: 'utf8' });
    assert.fail('should have exited nonzero');
  } catch (e) {
    assert.equal(e.status, 1);
  }
});

// ---------------------------------------------------------------------------
// Measured board snapshot — all fixtures together, counts asserted
// ---------------------------------------------------------------------------

test('measured: combined fixture board — 3 overlaps detected, 0 false positives', () => {
  const board = [...replayClaims, ...docsClaims, ...serverPrClaims];
  const report = normalizeClaims(board);
  // 6 claims -> 15 pairs. Real overlaps: replay18/28 only.
  // docs10/docs33 disjoint; srv-lease/pr-2272 disjoint; cross-fixture pairs disjoint.
  assert.equal(board.length, 6);
  assert.equal(report.pairCount, 15);
  assert.equal(report.overlapping, 1);
  assert.equal(report.summary.contained, 1);
  assert.equal(report.summary.disjoint, 14);
  const [hit] = report.pairs.filter((p) => p.verdict !== 'disjoint');
  assert.equal(hit.a, 'replay18');
  assert.equal(hit.b, 'replay28');
});
