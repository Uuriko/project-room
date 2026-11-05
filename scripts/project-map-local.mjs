#!/usr/bin/env node
// Explicit setup may download dependencies. Builds only read committed source blobs;
// Graphify receives an isolated source tree, empty HOME, and no provider credentials.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeRepo, graphFromGraphify, mapQuery, mapPath, mapHotspots, mapExplain } from '../server/project-map.mjs';
export const GRAPHIFY_VERSION = '0.9.96';
export const DEFAULT_RUNTIME = join(homedir(), '.cache', 'project-room', `graphify-${GRAPHIFY_VERSION}`);
const OFFLINE_ENTRY = `import runpy, socket, sys
def deny(*args, **kwargs):
    raise RuntimeError('Network disabled during Project Room graph extraction')
socket.create_connection = deny
socket.socket.connect = deny
socket.socket.connect_ex = deny
sys.argv = ['graphify'] + sys.argv[1:]
runpy.run_module('graphify', run_name='__main__')
`;
const EXTENSIONS = new Set('.js .mjs .cjs .jsx .ts .tsx .mts .cts .py .go .rs .java .c .h .cpp .hpp .cs .rb .swift .kt .scala .php .ex .exs .lua .sh .zig'.split(' '));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 300000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
export function setup(runtime = DEFAULT_RUNTIME) {
  run('uv', ['venv', runtime, '--python', '3.12']);
  run('uv', ['pip', 'install', '--python', join(runtime, 'bin/python'), `graphifyy==${GRAPHIFY_VERSION}`]);
  return { runtime, graphifyVersion: GRAPHIFY_VERSION };
}
export function materialize(checkout, revision, destination, scope = '') {
  const git = args => run('git', ['-C', resolve(checkout), ...args]);
  if (typeof revision !== 'string' || revision.startsWith('-')) throw new Error('Invalid revision');
  const sha = git(['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid resolved commit');
  if (scope && (scope.startsWith('/') || scope.split('/').some(part => part === '..' || !part))) throw new Error('Invalid scope');
  const rows = git(['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean);
  const selected = rows.map(row => {
    const split = row.indexOf('\t'); const [mode, type, oid] = row.slice(0, split).split(' ');
    return { mode, type, oid, path: row.slice(split + 1) };
  }).filter(row => (!scope || row.path === scope || row.path.startsWith(scope + '/')) && row.type === 'blob' && /^100(644|755)$/.test(row.mode) && EXTENSIONS.has(extname(row.path)) && !row.path.split('/').some(part => part.startsWith('.') || ['node_modules', 'vendor', 'ops', 'secrets', 'credentials'].includes(part)));
  if (!selected.length) throw new Error('No supported committed source files');
  if (selected.length > 10000) throw new Error('Source file limit exceeded (10000)');
  const batch = run('git', ['-C', resolve(checkout), 'cat-file', '--batch'], { input: selected.map(row => row.oid).join('\n') + '\n', encoding: null });
  let cursor = 0; let totalBytes = 0;
  for (const row of selected) {
    const end = batch.indexOf(10, cursor); const header = batch.subarray(cursor, end).toString().split(' '); const size = Number(header[2]);
    if (header[0] !== row.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size > 2 * 1024 * 1024) throw new Error('Invalid or oversized source blob');
    totalBytes += size; if (totalBytes > 64 * 1024 * 1024) throw new Error('Source byte limit exceeded');
    const target = resolve(destination, row.path);
    if (!target.startsWith(resolve(destination) + '/')) throw new Error('Unsafe source path');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, batch.subarray(end + 1, end + 1 + size)); cursor = end + size + 2;
  }
  return { revision: sha, sourceFiles: selected.length, sourceBytes: totalBytes, sourceManifestSha256: createHash('sha256').update(selected.map(row => `${row.path}\0${row.oid}\n`).join('')).digest('hex'), scope: scope || 'committed-source-allowlist' };
}
// A projection for Room's existing importer, not a full upstream graph export.
// Retain every node and every relation the importer can consume; numeric IDs
// replace repeated upstream symbol strings without changing edge targets.
export function compactGraph(graph) {
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) throw new Error('Unsupported raw Graphify export');
  const ids = new Map();
  const fields = ['label', 'name', 'data', 'file', 'source_file', 'path', 'location', 'line', 'source_location', 'type', 'kind', '_callable'];
  const nodes = graph.nodes.map((node, index) => {
    if (node.id === undefined || ids.has(String(node.id))) throw new Error('Missing or duplicate Graphify node ID');
    ids.set(String(node.id), index);
    const compact = { id: index, ...Object.fromEntries(fields.filter(key => node[key] !== undefined).map(key => [key, node[key]])) };
    if (!compact.file && typeof compact.source_file === 'string') { compact.file = compact.source_file; delete compact.source_file; }
    if (!Number.isInteger(compact.line)) {
      const location = compact.source_location;
      const match = typeof location === 'string' ? /^L?(\d+)/.exec(location) : null;
      if (Number.isInteger(location?.line)) compact.line = location.line;
      else if (match) compact.line = Number(match[1]);
    }
    if (Number.isInteger(compact.line)) delete compact.source_location;
    return compact;
  });
  const edges = [];
  for (const edge of graph.edges) {
    const relation = String(edge.kind || edge.relation || edge.type || edge.label || '');
    if (!/import|depend|call|invoke/i.test(relation)) continue;
    const source = ids.get(String(edge.from ?? edge.source ?? ''));
    const target = ids.get(String(edge.to ?? edge.target ?? ''));
    if (source === undefined || target === undefined) throw new Error('Unresolved structural Graphify edge');
    // Existing importer aliases retain the same endpoints/relation while saving
    // ten JSON bytes per edge. The publisher hashes these exact exported bytes.
    edges.push({ from: source, to: target, kind: relation });
  }
  return {
    built_at_commit: graph.built_at_commit,
    ...(graph.truncated === true ? { truncated: true } : {}),
    graph: { ...graph.graph, projection: 'room-files-symbols-imports-calls-v1', semantic_completeness: 'partial', raw_sha256: createHash('sha256').update(JSON.stringify(graph)).digest('hex'), raw_nodes: graph.nodes.length, raw_edges: graph.edges.length },
    nodes, edges
  };
}
export function build({ checkout = '.', revision = 'HEAD', repo, runtime = DEFAULT_RUNTIME, out, scope = '', compact = false }) {
  repo = normalizeRepo(repo); if (!repo) throw new Error('--repo owner/name is required');
  if (!out) throw new Error('--out is required');
  const python = join(resolve(runtime), 'bin/python');
  if (!existsSync(python)) throw new Error('Graphify runtime missing; run setup first');
  const version = run(python, ['-I', '-c', 'import importlib.metadata; print(importlib.metadata.version("graphifyy"))']).trim();
  if (version !== GRAPHIFY_VERSION) throw new Error(`Expected graphifyy ${GRAPHIFY_VERSION}, found ${version}`);
  const temp = mkdtempSync(join(tmpdir(), 'room-graphify-'));
  try {
    const source = join(temp, 'source'); mkdirSync(source); const provenance = materialize(checkout, revision, source, scope);
    const home = join(temp, 'home'); mkdirSync(home);
    run(python, ['-I', '-c', OFFLINE_ENTRY, 'extract', source, '--code-only', '--no-cluster', '--max-workers', '1', '--out', join(temp, 'output')], {
      cwd: source,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: temp, LANG: 'en_US.UTF-8', PYTHONHASHSEED: '0', GRAPHIFY_BACKEND: 'none', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' }
    });
    let graph = JSON.parse(readFileSync(join(temp, 'output/graphify-out/graph.json'), 'utf8'));
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Unsupported Graphify export');
    // Materialized tree has no .git. This binding is established by git blobs above.
    if (graph.input_tokens || graph.output_tokens) throw new Error('Unexpected model token usage in code-only extraction');
    graph.built_at_commit = provenance.revision;
    graph.graph = { ...graph.graph, graphify_version: version, export_format: 'graphify-extract-no-cluster', source_scope: provenance.scope, source_manifest_sha256: provenance.sourceManifestSha256 };
    if (compact) graph = compactGraph(graph);
    const envelope = { repo, revision: provenance.revision, graph, provenance: { ...provenance, engine: 'graphify', graphifyVersion: version, mode: 'code-only', modelCalls: 0, builtAt: Date.now() } };
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const pending = `${resolve(out)}.${process.pid}.tmp`;
    try { writeFileSync(pending, JSON.stringify(envelope) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(pending, resolve(out)); } finally { rmSync(pending, { force: true }); }
    return { ...envelope.provenance, out: resolve(out), nodes: graph.nodes.length, edges: graph.edges.length };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export function query(envelope, action, terms = []) {
  if (!envelope?.graph || !normalizeRepo(envelope.repo) || !envelope.revision || envelope.graph.built_at_commit !== envelope.revision) throw new Error('Invalid map envelope or revision binding');
  const builtAt = Number.isSafeInteger(envelope.provenance?.builtAt) && envelope.provenance.builtAt >= 0 ? envelope.provenance.builtAt : 0;
  const graph = graphFromGraphify(envelope.graph, { repo: envelope.repo, revision: envelope.revision, now: builtAt });
  if (action === 'query') return mapQuery(graph, terms.join(' '));
  if (action === 'path') return mapPath(graph, terms[0], terms[1]);
  if (action === 'hotspots') return mapHotspots(graph);
  if (action === 'explain') return mapExplain(graph, terms.join(' '));
  throw new Error(`Unknown action: ${action}`);
}
export function main(args) {
  const [action, ...rest] = args;
  if (action === "--help") return { usage: "setup | build --repo owner/name --checkout PATH --revision SHA [--scope PATH] [--compact] --out FILE | query FILE SYMBOL_OR_PATH | path FILE FROM TO | hotspots FILE | explain FILE SYMBOL_OR_PATH" };
  if (action === 'setup') { if (rest.length) throw new Error('Usage: setup'); return setup(); }
  if (action === 'build') {
    const options = {}; for (let i = 0; i < rest.length;) {
      if (rest[i] === '--compact') { options.compact = true; i += 1; continue; }
      const key = rest[i].replace(/^--/, ''); if (!rest[i].startsWith('--') || !['checkout', 'revision', 'repo', 'runtime', 'out', 'scope'].includes(key) || !rest[i + 1]) throw new Error('Invalid build option'); options[key] = rest[i + 1]; i += 2;
    } return build(options);
  }
  if (['query', 'path', 'hotspots', 'explain'].includes(action) && rest[0]) return query(JSON.parse(readFileSync(rest[0], 'utf8')), action, rest.slice(1));
  throw new Error('Usage: project-map-local.mjs setup | build --repo owner/name --checkout PATH --revision SHA --out FILE [--scope PATH] [--compact] | query FILE TEXT | path FILE FROM TO | hotspots FILE | explain FILE SYMBOL');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
