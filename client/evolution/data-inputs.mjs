import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, writeFileSync, readdirSync, unlinkSync, copyFileSync, statfsSync, utimesSync, opendirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { edgeDoorApiPath } from '../../src/service-origin.js';
import { canonical, digest, event, privateDir, requireThat } from './store.mjs';

const name = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relative = value => typeof value === 'string' && value.length < 512 && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const readPolicy = store => JSON.parse(store.db.prepare("SELECT value FROM settings WHERE id='policy'").get()?.value ?? '{}');
const sourceKey = id => 'data-source-' + id;

// Called by the local owner/app folder picker, never by a remote task. Sharing
// a folder with remote requesters is an explicit standing grant, not inferred
// from the worker's ability to read it.
export function registerDataSource(store, { id, root, rooms, capabilities, requesters = [] }) {
  requireThat(name(id) && typeof root === 'string' && [rooms, capabilities].every(a => Array.isArray(a) && a.length > 0)
    && [rooms, capabilities, requesters].every(a => Array.isArray(a) && a.every(v => typeof v === 'string' && v.length > 0)), 'invalid_data_source');
  const path = realpathSync(root), stat = lstatSync(path);
  requireThat(stat.isDirectory(), 'data_source_not_directory');
  const value = { id, kind: 'folder', root: path, dev: stat.dev, ino: stat.ino, rooms, capabilities, requesters };
  store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(sourceKey(id), canonical(value));
  event(store, 'data.source_registered', id, { kind: 'folder', rooms, capabilities, remoteEnabled: requesters.length > 0 });
  return { id, kind: 'folder', rooms, capabilities, remoteEnabled: requesters.length > 0 };
}
export function removeDataSource(store, id) {
  requireThat(name(id), 'invalid_data_source');
  const removed = store.db.prepare('DELETE FROM settings WHERE id=?').run(sourceKey(id)).changes > 0;
  event(store, 'data.source_removed', id, { removed }); return { id, removed, existingRunCopiesDeleted: false };
}
export function listDataSources(store) {
  return store.db.prepare("SELECT value FROM settings WHERE id LIKE 'data-source-%' ORDER BY id").all().map(row => {
    const { id, kind, rooms, capabilities, requesters } = JSON.parse(row.value);
    return { id, kind, rooms, capabilities, remoteEnabled: requesters.length > 0 };
  });
}
export function validateDataInputs(inputs) {
  requireThat(Array.isArray(inputs) && inputs.length <= 32, 'invalid_data_inputs');
  const names = new Set();
  for (const item of inputs) {
    requireThat(item && name(item.name) && !names.has(item.name), 'invalid_data_input_name'); names.add(item.name);
    const keys = item.kind === 'folder' ? ['name', 'kind', 'sourceId', 'path', 'sha256'] : ['name', 'kind', 'id', 'sha256'];
    requireThat(Object.keys(item).every(key => keys.includes(key)) && (item.sha256 === undefined || hash(item.sha256)), 'invalid_data_input');
    requireThat(item.kind === 'folder' ? name(item.sourceId) && relative(item.path)
      : item.kind === 'room-file' && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200 && hash(item.sha256), 'invalid_data_input');
  }
  return inputs;
}

// A local app/CLI discovery operation, not a remote source-access grant. The
// complete bounded manifest can be submitted unchanged as job.dataInputs.
export function scanDataSource(store, { sourceId, room, capability, path = '', extensions, maxFiles = 32 }) {
  requireThat(name(sourceId) && typeof room === 'string' && typeof capability === 'string'
    && (path === '' || relative(path)) && Number.isInteger(maxFiles) && maxFiles > 0 && maxFiles <= 32
    && Array.isArray(extensions) && extensions.length > 0 && extensions.length <= 32
    && extensions.every(e => typeof e === 'string' && /^\.[a-z0-9]{1,12}$/.test(e)), 'invalid_source_scan');
  const job = { room, payload: { capability } }, item = { sourceId }, budget = limits(store);
  const source = folderSource(store, job, item), start = path ? resolve(source.root, path) : source.root;
  requireThat(start === source.root || start.startsWith(source.root + sep), 'data_path_escape');
  const files = []; let visited = 0, totalBytes = 0, skipped = 0;
  function visit(directory, prefix, depth) {
    requireThat(depth <= 8, 'data_scan_depth_limit');
    requireThat(realpathSync(directory) === directory && lstatSync(directory).isDirectory(), 'data_symlink');
    const dir = opendirSync(directory);
    try {
      for (let entry; (entry = dir.readSync()) !== null;) {
        requireThat(++visited <= 2048, 'data_scan_entry_limit');
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) { skipped++; continue; }
        const child = join(directory, entry.name), relativePath = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { visit(child, relativePath, depth + 1); continue; }
        if (!entry.isFile() || !extensions.some(e => entry.name.toLowerCase().endsWith(e))) { skipped++; continue; }
        requireThat(files.length < maxFiles, 'data_scan_file_limit');
        requireThat(canonical(folderSource(store, job, item)) === canonical(source), 'data_source_changed');
        const bytes = readRegular(child, Math.min(budget.maxFileBytes, budget.maxTotalBytes - totalBytes));
        totalBytes += bytes.length;
        const extension = extensions.find(e => entry.name.toLowerCase().endsWith(e));
        files.push({ path: relativePath, bytes: bytes.length,
          input: { name: 'input-' + digest(relativePath).slice(0, 24) + extension, kind: 'folder', sourceId, path: relativePath, sha256: digest(bytes) } });
      }
    } finally { dir.closeSync(); }
    requireThat(realpathSync(directory) === directory, 'data_source_changed');
  }
  visit(start, path, 0);
  requireThat(canonical(folderSource(store, job, item)) === canonical(source), 'data_source_changed');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const dataInputs = validateDataInputs(files.map(file => file.input));
  return { sourceId, room, capability, observedAt: Date.now(), totalBytes, visited, skipped,
    dataInputs, manifestDigest: digest(canonical(dataInputs)), consistency: 'individual-file-snapshots' };
}
function limits(store) {
  const p = readPolicy(store), value = { maxFileBytes: 16 * 1024 ** 2, maxTotalBytes: 64 * 1024 ** 2, maxCacheBytes: 256 * 1024 ** 2, ...p.dataLimits };
  requireThat(['maxFileBytes', 'maxTotalBytes', 'maxCacheBytes'].every(k => Number.isSafeInteger(value[k]) && value[k] > 0)
    && value.maxFileBytes <= 64 * 1024 ** 2 && value.maxFileBytes <= value.maxTotalBytes
    && value.maxTotalBytes <= 1024 ** 3 && value.maxFileBytes <= value.maxCacheBytes && value.maxCacheBytes <= 4 * 1024 ** 3, 'invalid_data_limits');
  return { ...value, reserveDiskBytes: p.reserveDiskBytes ?? 0 };
}
function folderSource(store, job, item, context) {
  const p = readPolicy(store), row = store.db.prepare('SELECT value FROM settings WHERE id=?').get(sourceKey(item.sourceId));
  requireThat(!p.paused && p.rooms?.includes(job.room) && p.capabilities?.includes(job.payload.capability) && row, 'data_source_not_authorized');
  const source = JSON.parse(row.value);
  requireThat(source.rooms.includes(job.room) && source.capabilities.includes(job.payload.capability)
    && (!context || source.requesters.includes(context.requesterId)), 'data_source_not_authorized');
  const stat = lstatSync(source.root);
  requireThat(stat.isDirectory() && realpathSync(source.root) === source.root && stat.dev === source.dev && stat.ino === source.ino, 'data_source_changed');
  return source;
}
function readRegular(path, maxBytes) {
  requireThat(realpathSync(path) === path, 'data_symlink');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    requireThat(before.isFile() && before.size <= maxBytes, 'data_file_limit');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    const after = fstatSync(fd);
    requireThat(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && realpathSync(path) === path && lstatSync(path).ino === before.ino && lstatSync(path).dev === before.dev, 'data_changed_during_read');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
async function roomBytes(job, item, context, signal, maxBytes) {
  requireThat(context?.connection && context.requestMessageId && context.requesterId && context.roomCreatedEventId
    && context.connection.roomId === job.room, 'data_room_context_required');
  const a = context.connection, path = `/api/rooms/${encodeURIComponent(a.roomId)}/files/${encodeURIComponent(item.id)}`;
  const response = await (a.fetchImpl ?? fetch)(a.origin + edgeDoorApiPath(a.origin, path), {
    headers: { Authorization: `Bearer ${a.token}` }, credentials: 'omit', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('data_http_' + response.status); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length;
      requireThat(length <= Math.min(1500000, Math.ceil(maxBytes * 4 / 3) + 16384), 'data_response_limit'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const file = JSON.parse(Buffer.concat(chunks).toString('utf8')).attachment;
  // The worker may see files the requester cannot. Only attachments committed
  // to this authenticated request can be used without a separate source grant.
  requireThat(file?.id === item.id && file.state === 'committed' && file.messageId === context.requestMessageId
    && file.uploaderId === context.requesterId && file.encoding === 'base64' && typeof file.data === 'string'
    && Number.isSafeInteger(file.byteLength) && file.byteLength <= maxBytes && file.sha256 === item.sha256, 'data_attachment_scope_mismatch');
  const bytes = Buffer.from(file.data, 'base64');
  requireThat(bytes.toString('base64') === file.data && bytes.length === file.byteLength, 'data_attachment_invalid');
  return bytes;
}
function cacheFile(store, bytes, sha256, budget) {
  const root = privateDir(join(store.directory, 'data-cache')), target = join(root, sha256);
  const files = readdirSync(root).filter(hash).map(id => { const stat = lstatSync(join(root, id));
    requireThat(stat.isFile() && !stat.isSymbolicLink(), 'data_cache_invalid'); return { id, size: stat.size, mtimeMs: stat.mtimeMs }; });
  let total = files.reduce((sum, f) => sum + f.size, 0);
  const hit = files.find(f => f.id === sha256);
  if (hit) requireThat(digest(readRegular(target, budget.maxFileBytes)) === sha256, 'data_cache_corrupt');
  for (const file of files.filter(f => f.id !== sha256).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total + (hit ? 0 : bytes.length) <= budget.maxCacheBytes) break;
    unlinkSync(join(root, file.id)); total -= file.size;
  }
  requireThat(total + (hit ? 0 : bytes.length) <= budget.maxCacheBytes, 'data_cache_full');
  const fs = statfsSync(store.directory, { bigint: true });
  requireThat(fs.bavail * fs.bsize >= BigInt(budget.reserveDiskBytes + bytes.length * (hit ? 1 : 2)), 'data_disk_headroom');
  if (!hit) {
    try { writeFileSync(target, bytes, { mode: 0o400, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; requireThat(digest(readRegular(target, budget.maxFileBytes)) === sha256, 'data_cache_corrupt'); }
  }
  utimesSync(target, new Date(), new Date());
  return { path: target, reused: Boolean(hit) };
}
export async function materializeDataInputs(store, job, directory, { context, signal } = {}) {
  const inputs = validateDataInputs(job.payload.dataInputs ?? []), budget = limits(store), entries = [];
  const root = privateDir(join(directory, 'data')); let total = 0;
  for (const item of inputs) {
    signal?.throwIfAborted(); let bytes, provenance;
    if (item.kind === 'folder') {
      const source = folderSource(store, job, item, context), path = resolve(source.root, item.path);
      requireThat(path.startsWith(source.root + sep), 'data_path_escape');
      bytes = readRegular(path, Math.min(budget.maxFileBytes, budget.maxTotalBytes - total));
      requireThat(canonical(folderSource(store, job, item, context)) === canonical(source), 'data_source_changed');
      provenance = { kind: 'folder', sourceId: item.sourceId, path: item.path };
    } else {
      bytes = await roomBytes(job, item, context, signal, Math.min(budget.maxFileBytes, budget.maxTotalBytes - total));
      provenance = { kind: 'room-file', id: item.id, origin: context.connection.origin, room: job.room,
        roomCreatedEventId: context.roomCreatedEventId, messageId: context.requestMessageId };
    }
    signal?.throwIfAborted(); total += bytes.length;
    requireThat(total <= budget.maxTotalBytes, 'data_total_limit');
    const sha256 = digest(bytes); requireThat(item.sha256 === undefined || sha256 === item.sha256, 'data_hash_mismatch');
    const cached = cacheFile(store, bytes, sha256, budget), path = join(root, item.name);
    copyFileSync(cached.path, path, constants.COPYFILE_EXCL);
    requireThat(digest(readRegular(path, budget.maxFileBytes)) === sha256, 'data_copy_corrupt');
    entries.push({ name: item.name, path, sha256, bytes: bytes.length, provenance, observedAt: Date.now(), cacheReused: cached.reused });
  }
  const manifest = { schema: 1, jobId: job.id, attempt: job.attempt, entries, totalBytes: total };
  const path = join(directory, 'data.json'); writeFileSync(path, canonical(manifest), { mode: 0o400, flag: 'wx' });
  event(store, 'job.inputs_materialized', job.id, { attempt: job.attempt, files: entries.length, totalBytes: total,
    manifestDigest: digest(canonical(entries.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })))) });
  return { path, manifest };
}
