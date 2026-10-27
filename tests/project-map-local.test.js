import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { materialize, query, main, compactGraph, DEFAULT_RUNTIME } from '../scripts/project-map-local.mjs';
import { graphFromGraphify, mapQuery, mapPath, mapHotspots, mapExplain } from '../server/project-map.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-local-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'helper.py'), 'def helper():\n    return 1\n');
  writeFileSync(join(repo, 'entry.py'), 'from helper import helper\ndef entry():\n    return helper()\n');
  writeFileSync(join(repo, '.env'), 'EXAMPLE_SECRET=not-real'); symlinkSync('/etc/passwd', join(repo, 'outside.py'));
  mkdirSync(join(repo, 'ops')); writeFileSync(join(repo, 'ops/private.py'), 'secret = 1\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']); const sha = git(['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'helper.py'), 'def dirty(): pass\n'); writeFileSync(join(repo, 'untracked.py'), 'def untracked(): pass\n');
  return { root, repo, sha };
}
test('materializes immutable committed source, excluding symlinks, config, private lanes and dirty files', t => {
  const { root, repo, sha } = fixture(t); const destination = join(root, 'source'); mkdirSync(destination);
  const result = materialize(repo, sha, destination);
  assert.equal(result.revision, sha); assert.equal(result.sourceFiles, 2);
  assert.match(readFileSync(join(destination, 'helper.py'), 'utf8'), /def helper/);
  for (const path of ['.env', 'outside.py', 'untracked.py', 'ops']) assert.equal(existsSync(join(destination, path)), false);
  assert.throws(() => materialize(repo, 'missing-ref', destination), /failed/);
});
test('query requires binding and supports local graph operations', () => {
  const envelope = { repo: 'owner/repo', revision: 'a'.repeat(40), graph: { built_at_commit: 'a'.repeat(40), nodes: [{ id: 'a', label: 'entry', source_file: 'entry.py' }], links: [], graph: { schema_version: 1 } } };
  assert.ok(JSON.stringify(query(envelope, 'query', ['entry'])).includes('entry.py'));
  for (const operation of ['hotspots', 'explain', 'path']) assert.doesNotThrow(() => query(envelope, operation, ['entry.py', 'entry.py']));
  assert.throws(() => query({ ...envelope, revision: 'b'.repeat(40) }, 'query'), /binding/);
  assert.throws(() => main(['build', '--bad', 'x']), /Invalid build option/);
});
test('real pinned Graphify extracts and queries an exact committed fixture', { skip: !process.env.ROOM_TEST_GRAPHIFY }, t => {
  const { root, repo, sha } = fixture(t); const out = join(root, 'map.json');
  const result = main(['build', '--compact', '--checkout', repo, '--revision', sha, '--repo', 'owner/repo', '--runtime', DEFAULT_RUNTIME, '--out', out]);
  assert.equal(result.graphifyVersion, '0.9.96'); assert.ok(result.nodes > 0);
  const envelope = JSON.parse(readFileSync(out)); assert.equal(envelope.graph.built_at_commit, sha);
  assert.ok(JSON.stringify(query(envelope, 'query', ['helper'])).includes('helper.py'), JSON.stringify(envelope.graph).slice(0,3000));
  assert.ok(!JSON.stringify(envelope.graph).includes('untracked'));
});

test('compact export preserves Room queries, exact caller targets and every supported edge', () => {
  const raw = { built_at_commit: 'a'.repeat(40), graph: { graphify_version: '0.9.96', source_scope: 'server' }, nodes: [
    { id: 'entry', label: 'entry.js', source_file: 'entry.js', kind: 'file' },
    { id: 'caller', label: 'run()', source_file: 'entry.js', source_location: 'L2', _callable: true },
    { id: 'first', label: 'same()', source_file: 'a.js', source_location: 'L7' },
    { id: 'second', label: 'same()', source_file: 'b.js', source_location: 'L9' }
  ], edges: [
    { source: 'entry', target: 'caller', relation: 'contains' },
    { source: 'caller', target: 'second', relation: 'calls', confidence: 'EXTRACTED', context: 'discarded detail' },
    { source: 'entry', target: 'first', relation: 'imports_from' },
    { source: 'caller', target: 'first', relation: 'depends_on' },
    { source: 'entry', target: 'second', relation: 'invokes' }
  ] };
  const compact = compactGraph(raw);
  assert.equal(compact.nodes.length, raw.nodes.length); assert.equal(compact.edges.length, 4);
  assert.equal(compact.graph.raw_sha256.length, 64); assert.equal(compact.graph.source_scope, 'server');
  assert.equal(compact.built_at_commit, raw.built_at_commit);
  assert.equal(compact.graph.projection, 'room-files-symbols-imports-calls-v1');
  const args = { repo: 'owner/repo', revision: raw.built_at_commit, now: 1 };
  const before = graphFromGraphify(raw, args); const after = graphFromGraphify(compact, args);
  assert.deepEqual(after, before);
  for (const term of ['entry.js', 'a.js', 'b.js', 'same()', 'run']) {
    assert.deepEqual(mapQuery(after, term), mapQuery(before, term));
    assert.deepEqual(mapExplain(after, term), mapExplain(before, term));
  }
  assert.deepEqual(mapPath(after, 'entry.js', 'b.js'), mapPath(before, 'entry.js', 'b.js'));
  assert.deepEqual(mapHotspots(after), mapHotspots(before));
  assert.throws(() => compactGraph({ ...raw, edges: [{ source: 'caller', target: 'absent', relation: 'calls' }] }), /Unresolved/);
});

test('local query reports persisted build time and never invents freshness for legacy graphs', () => {
  const envelope = { repo: 'owner/repo', revision: 'a'.repeat(40), provenance: { builtAt: 123456 }, graph: {
    built_at_commit: 'a'.repeat(40), nodes: [{ id: 'a', label: 'entry', source_file: 'entry.py' }], edges: []
  } };
  assert.equal(query(envelope, 'query', ['entry']).builtAt, 123456);
  assert.deepEqual(query(envelope, 'query', ['entry']), query(envelope, 'query', ['entry']));
  delete envelope.provenance;
  assert.equal(query(envelope, 'query', ['entry']).builtAt, 0);
  assert.equal(query({ ...envelope, provenance: { builtAt: 'invalid' } }, 'query', ['entry']).builtAt, 0);
});
