import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Only enrollment is a fixture. Map writes, authentication, MCP reads and CAS
// traverse the production Worker/Node bridge and durable SQLite storage.
const fixture = `
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { linkWithProof } from '../tests/helpers/link-with-proof.mjs';
export class MapTestRoom extends ProjectRoom {
 async fetch(request) {
  if (new URL(request.url).pathname === '/__fixture/setup' && request.method === 'POST') {
   this.store.initialize(initialRoom());
   const ownerKey = this.store.issueAccessKey('commons','owner');
   const identity = this.store.identities.create('Map reader');
   linkWithProof(this.store,ownerKey,'commons',identity,{memberId:'reader',displayName:'Map reader',permissions:[]});
   return Response.json({ownerKey,readerSecret:identity.secret,readerKey:this.store.issueAccessKey('commons','reader')});
  }
  return super.fetch(request);
 }
}
export default entry;
`;

test('actual Worker Graphify upload is authorized, revision fenced, MCP readable and durable across reopen', { timeout: 60000 }, async () => {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'project-map-local-fixture.mjs' }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'project-map-worker-'));
  const origin = 'https://room.example.test';
  const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'MapTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin, ROOM_PROJECT_MAP_GRAPHIFY: 'on', ROOM_PROJECT_MAP_REPO: 'example/project' }, durableObjectsPersist: persistence };
  let worker = new Miniflare(config);
  const api = (path, data, secret) => worker.dispatchFetch(new URL(path, origin), { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(secret ? { Authorization: 'Bearer ' + secret } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
  const mcp = async (secret, path = '/mcp') => {
    const response = await json(await api(path, { jsonrpc: '2.0', id: 'map', method: 'tools/call', params: { name: 'room_map', arguments: { roomId: 'commons', repo: 'example/project', op: 'query', q: 'helper.js' } } }, secret));
    assert.equal(response.error, undefined, JSON.stringify(response)); assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
    return response.result.structuredContent;
  };
  const makeUpload = (revision, expectedRevision) => {
    const graph = { built_at_commit: revision, graph: { graphify_version: '0.9.96', export_format: 'graphify-extract-no-cluster', source_scope: 'server' }, nodes: [
      { id: 0, label: 'entry.js', source_file: 'entry.js', kind: 'file' },
      { id: 1, label: 'helper()', source_file: 'helper.js', source_location: 'L2' }
    ], edges: [{ source: 0, target: 1, relation: 'imports' }, { source: 0, target: 1, relation: 'calls' }] };
    return { repo: 'example/project', revision, expectedRevision, graphify: { repo: 'example/project', revision, graph } };
  };
  try {
    const { ownerKey, readerKey, readerSecret } = await json(await api('/__fixture/setup', {}));
    const first = makeUpload('a'.repeat(40), null);
    await json(await api('/api/rooms/commons/map', first), 401);
    await json(await api('/api/rooms/commons/map', first, readerKey), 403);
    const before = await mcp(readerSecret); assert.equal(before.found, false);
    const written = await json(await api('/api/rooms/commons/map', first, ownerKey));
    assert.equal(written.engine, 'graphify'); assert.equal(written.revision, first.revision);
    assert.equal(written.provenance.graphSha256, createHash('sha256').update(JSON.stringify(first.graphify.graph)).digest('hex'));
    const observed = await mcp(readerSecret);
    assert.equal(observed.found, true); assert.equal(observed.revision, first.revision); assert.equal(observed.engine, 'graphify');
    assert.ok(observed.callers.some(caller => caller.file === 'entry.js'));
    assert.equal(observed.provenance.revisionVerified, false);
    const stale = makeUpload('b'.repeat(40), null);
    assert.equal((await json(await api('/api/rooms/commons/map', stale, ownerKey), 409)).error.code, 'stale_project_map');
    await json(await api('/api/rooms/commons/map', makeUpload('b'.repeat(40), first.revision), readerKey), 403);
    assert.deepEqual(await mcp(readerSecret), observed);
    await worker.dispose(); worker = new Miniflare(config);
    assert.deepEqual(await mcp(readerSecret, '/room/mcp'), observed);
    const second = makeUpload('b'.repeat(40), first.revision);
    await json(await api('/api/rooms/commons/map', second, ownerKey));
    assert.equal((await mcp(readerSecret)).revision, second.revision);
    assert.equal((await json(await api('/api/rooms/commons/map', first, ownerKey), 409)).error.code, 'stale_project_map');
    await worker.dispose(); worker = new Miniflare(config);
    assert.equal((await mcp(readerSecret)).revision, second.revision);
  } finally { await worker.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
