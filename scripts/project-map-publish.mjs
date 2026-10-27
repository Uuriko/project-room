import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment } from '../client/agent-connection.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { edgeDoorApiPath } from '../src/service-origin.js';
import { normalizeRepo } from '../server/project-map.mjs';

const LIMIT = 1_500_000;
const fail = code => Object.assign(new Error(code), { code });

// Bound every response, including the connection check, before parsing JSON.
function boundedFetch(fetchImpl) {
  return async (url, options) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await fetchImpl(url, { ...options, signal, redirect: 'error', credentials: 'omit' });
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw fail('redirect_refused');
    if (Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); throw fail('response_too_large'); }
    const chunks = []; let length = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > LIMIT) { await reader.cancel(); throw fail('response_too_large'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return new Response(length ? Buffer.concat(chunks) : null, { status: response.status, headers: response.headers });
  };
}

export async function publishProjectMap({ connection, envelope, fetchImpl = globalThis.fetch }) {
  const repo = normalizeRepo(envelope?.repo);
  if (!repo || typeof envelope?.revision !== 'string' || !envelope.revision.trim() || envelope.revision.length > 120
    || !envelope.graph || typeof envelope.graph !== 'object' || Array.isArray(envelope.graph)) throw fail('invalid_envelope');
  const root = !Array.isArray(envelope.graph.nodes) && envelope.graph.graph && typeof envelope.graph.graph === 'object'
    ? envelope.graph.graph : envelope.graph;
  const rows = value => Array.isArray(value) && value.every(row => row && typeof row === 'object' && !Array.isArray(row));
  if (!root || typeof root !== 'object' || Array.isArray(root) || !rows(root.nodes)
    || !(rows(root.edges) || (root.edges === undefined && rows(root.links)))) throw fail('invalid_envelope');
  const graphSha256 = createHash('sha256').update(JSON.stringify(envelope.graph)).digest('hex');
  const body = { repo, revision: envelope.revision, expectedRevision: null, expectedGraphSha256: null, graphify: envelope };
  // Reserve room for the existing revision before any credential-bearing I/O.
  if (Buffer.byteLength(JSON.stringify(body)) + 190 > LIMIT) throw fail('payload_too_large');
  const safeFetch = boundedFetch(fetchImpl);
  await new RoomAgentClient({ ...connection, fetchImpl: safeFetch }).checkConnection();
  const path = `/api/rooms/${encodeURIComponent(connection.roomId)}/map`;
  const request = async (suffix, payload) => {
    const response = await safeFetch(connection.origin + edgeDoorApiPath(connection.origin, path + suffix), {
      method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    if (!response.ok) throw fail(response.status === 409 ? 'revision_conflict' : 'publish_http_error');
    try { return await response.json(); } catch { throw fail('invalid_response'); }
  };
  const read = () => request(`/hotspots?repo=${encodeURIComponent(repo)}`);
  const current = await read();
  if (current?.enabled !== true || current.repo !== repo) throw fail('map_unavailable');
  if (current.found !== false && (typeof current.revision !== 'string' || !current.revision || current.revision.length > 120)) throw fail('invalid_response');
  body.expectedRevision = current.found === false ? null : current.revision;
  const currentHash = current.provenance?.graphSha256 ?? null;
  if (currentHash !== null && (typeof currentHash !== 'string' || !/^[a-f0-9]{64}$/.test(currentHash))) throw fail('invalid_response');
  body.expectedGraphSha256 = current.found === false ? null : currentHash;
  const matches = value => value?.enabled === true && value.repo === repo && value.revision === envelope.revision
    && value.provenance?.graphSha256 === graphSha256;
  let acknowledged;
  try { acknowledged = await request('', body); }
  catch (error) {
    // Never retry a mutation. A lost ACK is reconciled only against exact content.
    if (error.code === 'revision_conflict' || error.code === 'publish_http_error') throw error;
    const observed = await read();
    if (!matches(observed)) throw fail('publish_unconfirmed');
    return { status: 'reconciled', repo, revision: envelope.revision, graphSha256, truncated: observed.truncated === true };
  }
  if (!matches(acknowledged)) throw fail('publish_unconfirmed');
  const observed = await read();
  if (!matches(observed)) throw fail('publish_unconfirmed');
  return { status: 'published', repo, revision: envelope.revision, graphSha256, truncated: observed.truncated === true };
}

async function readEnvelope(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw fail('invalid_envelope');
    const bytes = Buffer.alloc(LIMIT + 1); let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > LIMIT) throw fail('payload_too_large');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
}

export async function main(args = process.argv.slice(2), { env = process.env, write = console.log, fetchImpl = globalThis.fetch } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    write('Usage: node scripts/project-map-publish.mjs --envelope FILE\nPublish a local Graphify {repo,revision,graph} envelope using the saved Room agent connection and expected member. Requires room map administration and configured Graphify intake.'); return 0;
  }
  try {
    if (args.length !== 2 || args[0] !== '--envelope') throw fail('usage_error');
    const envelope = await readEnvelope(args[1]);
    const result = await publishProjectMap({ connection: agentConnectionFromEnvironment(env), envelope, fetchImpl });
    write(JSON.stringify(result)); return 0;
  } catch (error) {
    // Neither remote error text nor untrusted exception messages enter output.
    const known = new Set(['usage_error', 'invalid_envelope', 'payload_too_large', 'response_too_large', 'redirect_refused',
      'revision_conflict', 'publish_http_error', 'invalid_response', 'map_unavailable', 'publish_unconfirmed', 'member_required',
      'identity_mismatch', 'invalid_config', 'config_not_private', 'config_not_found', 'ambiguous_config']);
    write(JSON.stringify({ status: 'failed', code: known.has(error.code) ? error.code : 'publish_failed' })); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
