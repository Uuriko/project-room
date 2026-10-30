import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { pushProjectMap, readProjectMap } from '../server/project-map-store.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('commons'));
  store.featureEnv = {}; t.after(() => store.close()); return store;
}
const update = { repo: 'test/repo', revision: 'a'.repeat(40), files: [{ path: 'a.js', source: 'export function hello() {}' }] };

test('invalid map update preserves previous graph and cannot poison intake', async t => {
  const store = fixture(t); await pushProjectMap(store, 'commons', update);
  for (const files of [Array.from({ length: 201 }, () => update.files[0]), [{ path: 'a.js', source: 'x'.repeat(65537) }]]) {
    await assert.rejects(pushProjectMap(store, 'commons', { ...update, revision: 'b', files }), { status: 422 });
    assert.equal(readProjectMap(store, 'commons', { q: 'hello' }).revision, update.revision);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_map_queue').get().n, 0);
  await assert.rejects(pushProjectMap(store, 'commons', { ...update, expectedRevision: 'stale' }), { status: 409 });
  await pushProjectMap(store, 'commons', { ...update, expectedRevision: update.revision, revision: 'b' });
  assert.equal(readProjectMap(store, 'commons', { q: 'hello' }).revision, 'b');
});

test('Graphify requires configured repo and a revision-bound envelope; reads disclose upload provenance', async t => {
  const store = fixture(t);
  const graph = { graph: { source_scope: 'server' }, nodes: [{ id: 'a', source_file: 'a.js', label: 'hello', type: 'function' }], links: [] };
  const body = { repo: update.repo, revision: update.revision, graphify: { repo: update.repo, revision: update.revision, graph } };
  await assert.rejects(pushProjectMap(store, 'commons', body), { status: 403 });
  store.featureEnv = { ROOM_PROJECT_MAP_GRAPHIFY: 'on', ROOM_PROJECT_MAP_REPO: 'other/repo' };
  await assert.rejects(pushProjectMap(store, 'commons', body), { status: 403 });
  store.featureEnv.ROOM_PROJECT_MAP_REPO = update.repo;
  await assert.rejects(pushProjectMap(store, 'commons', { ...body, graphify: { ...body.graphify, revision: 'wrong' } }), { status: 422 });
  const receipt = await pushProjectMap(store, 'commons', body);
  assert.equal(receipt.engine, 'graphify'); assert.equal(receipt.sourceScope, 'server');
  for (const op of ['query', 'path', 'explain', 'hotspots']) {
    const result = readProjectMap(store, 'commons', { op, q: 'hello', from: 'a.js', to: 'hello' });
    assert.equal(result.revision, update.revision); assert.equal(result.engine, 'graphify');
    assert.equal(result.sourceScope, 'server');
    assert.equal(result.provenance.revisionVerified, false);
    assert.match(result.provenance.graphSha256, /^[a-f0-9]{64}$/);
  }
});

test('reading a never-built map creates no storage tables', t => {
  const store = fixture(t);
  assert.equal(readProjectMap(store, 'commons', {}).found, false);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='project_maps'").get(), undefined);
});


test('malformed Graphify exports preserve the last valid map; explicit empty and wrapped exports remain supported', async t => {
  const store = fixture(t); await pushProjectMap(store, 'commons', update);
  store.featureEnv = { ROOM_PROJECT_MAP_GRAPHIFY: 'on', ROOM_PROJECT_MAP_REPO: update.repo };
  const publish = graph => pushProjectMap(store, 'commons', { repo: update.repo, revision: 'next',
    graphify: { repo: update.repo, revision: 'next', graph } });
  for (const graph of [{ unexpected: 'object' }, { nodes: [] }, { nodes: [], edges: {} },
    { nodes: [null], edges: [] }, { nodes: [], edges: [false] }, { graph: { nodes: [] } }]) {
    await assert.rejects(publish(graph), { status: 422 });
    const current = readProjectMap(store, 'commons', { q: 'hello' });
    assert.equal(current.revision, update.revision); assert.equal(current.found, true);
  }
  const empty = await publish({ nodes: [], edges: [] }); assert.equal(empty.files, 0);
  const wrapped = await publish({ graph: { nodes: [{ id: 'a', label: 'hello', source_file: 'a.js' }], links: [] } });
  assert.equal(wrapped.files, 1); assert.equal(readProjectMap(store, 'commons', { q: 'hello' }).found, true);
});


test('Graphify CAS refuses changed content at the same Git revision', async t => {
  const store = fixture(t); store.featureEnv = { ROOM_PROJECT_MAP_GRAPHIFY: 'on', ROOM_PROJECT_MAP_REPO: update.repo };
  const body = graph => ({ repo: update.repo, revision: update.revision, graphify: { repo: update.repo, revision: update.revision, graph } });
  const graph = label => ({ nodes: [{ id: 'a', label, source_file: 'a.js' }], edges: [] });
  const first = await pushProjectMap(store, 'commons', { ...body(graph('first')), expectedRevision: null, expectedGraphSha256: null });
  const second = await pushProjectMap(store, 'commons', { ...body(graph('second')), expectedRevision: update.revision, expectedGraphSha256: first.provenance.graphSha256 });
  await assert.rejects(pushProjectMap(store, 'commons', { ...body(graph('stale')), expectedRevision: update.revision,
    expectedGraphSha256: first.provenance.graphSha256 }), { status: 409, code: 'stale_project_map' });
  const actual = readProjectMap(store, 'commons', { q: 'second' });
  assert.equal(actual.found, true); assert.equal(actual.provenance.graphSha256, second.provenance.graphSha256);
});


test('oversize Graphify definition storage rejects atomically without replacing the previous graph', async t => {
  const store = fixture(t);
  store.featureEnv = {ROOM_PROJECT_MAP_GRAPHIFY: 'on', ROOM_PROJECT_MAP_REPO: update.repo};
  const body = (graph, revision) => ({repo: update.repo, revision, graphify: {repo: update.repo, revision, graph}});
  await pushProjectMap(store, 'commons', body({nodes: [{id: 0, file: 'one.js', label: 'original'}], edges: []}, 'previous'));
  const before = store.db.prepare('SELECT * FROM project_maps WHERE room_id=? AND repo=?').get('commons', update.repo);
  const graph = {nodes: Array.from({length: 10000}, (_, i) => ({id: i, file: 'one.js', label: String(i).padStart(8, '0')+'x'.repeat(150)})), edges: []};
  await assert.rejects(pushProjectMap(store, 'commons', body(graph, 'oversize')), {status: 422});
  assert.deepEqual(store.db.prepare('SELECT * FROM project_maps WHERE room_id=? AND repo=?').get('commons', update.repo), before);
  const current = readProjectMap(store, 'commons', {q: 'original'});
  assert.equal(current.found, true); assert.equal(current.revision, 'previous');
});
