import { constants, openSync, closeSync, readSync, realpathSync, fstatSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { RoomAgentClient } from '../room-agent.mjs';
import { edgeDoorApiPath } from '../../src/service-origin.js';
import { canonical, digest, requireThat, transaction } from './store.mjs';
import { getJob } from './executor.mjs';

const maxBytes = 1048576, maxTotal = 8388608, maxFiles = 32;
// Deterministic IDs bind both the destination and exact execution. No token or
// local path is embedded in a remote URL. This never starts or retries a job.
export function jobArtifactPlan(store, jobId, { origin, roomId, memberId, roomCreatedEventId, messageId }) {
  const job = getJob(store, jobId);
  requireThat(job.room === roomId && ['completed', 'needs_attention', 'cancelled'].includes(job.state)
    && job.result && Array.isArray(job.result.artifacts), 'artifact_result_required');
  requireThat([origin, roomId, memberId, roomCreatedEventId, messageId].every(v => typeof v === 'string' && v.length > 0), 'artifact_binding_required');
  const files = job.result.artifacts;
  requireThat(files.length <= maxFiles && files.reduce((sum, f) => sum + f.bytes, 0) <= maxTotal, 'artifact_upload_limit');
  requireThat(digest(canonical(files)) === job.result.artifactDigest, 'artifact_manifest_changed');
  const root = join(store.directory, 'runs', job.id, String(job.attempt), 'artifacts');
  requireThat(realpathSync(root) === root, 'artifact_path_invalid');
  return files.map(file => {
    requireThat(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= maxBytes, 'artifact_upload_limit');
    const path = resolve(root, file.path);
    requireThat(path.startsWith(root + sep) && realpathSync(path) === path, 'artifact_path_invalid');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const stat = fstatSync(fd);
      requireThat(stat.isFile() && stat.size === file.bytes, 'artifact_changed');
      const buffer = Buffer.alloc(file.bytes + 1); let length = 0, count;
      while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
      bytes = buffer.subarray(0, length);
    } finally { closeSync(fd); }
    requireThat(bytes.length === file.bytes && digest(bytes) === file.sha256, 'artifact_changed');
    const id = 'evidence-' + digest(canonical([origin, roomId, memberId, roomCreatedEventId, messageId, job.id, job.attempt, job.pin, file]));
    return { id, filename: basename(file.path), mediaType: 'application/octet-stream', sha256: file.sha256,
      byteLength: file.bytes, data: bytes.toString('base64') };
  });
}
async function boundedJson(response) {
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      length += value.length; requireThat(length <= 1500000, 'artifact_response_too_large'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
export async function publishJobArtifacts(store, { connection, jobId, requestMessageId, roomCreatedEventId, messageId, expectedAttempt, signal }) {
  const client = new RoomAgentClient(connection);
  requireThat(expectedAttempt === undefined || getJob(store, jobId).attempt === expectedAttempt, 'artifact_attempt_changed');
  // Pin incarnation to an authenticated formal request rather than a local
  // room name, which can be reused after deletion.
  const context = await client.replyContext(requestMessageId, { limit: 1, signal });
  requireThat(context.roomCreatedEventId === roomCreatedEventId && context.viewerId === connection.memberId
    && context.request.recipientId === connection.memberId, 'artifact_scope_changed');
  requireThat(context.request.status === 'answered' && context.request.responseMessageId === messageId, 'artifact_result_not_delivered');
  const plan = jobArtifactPlan(store, jobId, { ...connection, roomCreatedEventId, messageId });
  const base = `/api/rooms/${encodeURIComponent(connection.roomId)}/files`;
  const request = async (path, data) => {
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await (connection.fetchImpl ?? fetch)(connection.origin + edgeDoorApiPath(connection.origin, path), {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', signal: stop,
      headers: { Authorization: `Bearer ${connection.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('artifact_http_' + response.status), { status: response.status }); }
    return boundedJson(response);
  };
  const receipts = [];
  for (const file of plan) {
    const path = base + '/' + encodeURIComponent(file.id);
    let remote;
    try { remote = (await request(path)).attachment; } catch (error) { if (error.status !== 404) throw error; }
    if (!remote) remote = (await request(base, { id: file.id, filename: file.filename, mediaType: file.mediaType, data: file.data })).attachment;
    const matches = value => value?.id === file.id && value.uploaderId === connection.memberId
      && value.sha256 === file.sha256 && value.byteLength === file.byteLength && value.filename === file.filename && value.mediaType === file.mediaType;
    requireThat(matches(remote), 'artifact_remote_mismatch');
    requireThat(remote.state === 'staged' || (remote.state === 'committed' && remote.messageId === messageId), 'artifact_commit_conflict');
    if (remote.state === 'staged') await request(path + '/commit', { messageId });
    // Verify actual bytes after commit. A successful upload response is not
    // proof that the result remains readable or bound to the right message.
    const verified = (await request(path)).attachment;
    requireThat(matches(verified) && verified.state === 'committed' && verified.messageId === messageId
      && verified.encoding === 'base64' && typeof verified.data === 'string'
      && verified.data === file.data, 'artifact_readback_mismatch');
    receipts.push({ id: file.id, sha256: file.sha256, byteLength: file.byteLength, messageId, path });
  }
  return { jobId, artifactDigest: getJob(store, jobId).result.artifactDigest, evidenceLocation: 'room', files: receipts };
}

// Persist delivery intent before attempting network writes. The existing
// private settings journal holds only identifiers, never credentials or bytes.
export function queueJobArtifacts(store, args) {
  const { connection, jobId, requestMessageId, roomCreatedEventId, messageId } = args;
  const binding = { origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId,
    jobId, requestMessageId, roomCreatedEventId, messageId, expectedAttempt: getJob(store, jobId).attempt };
  const key = 'artifact-delivery-' + digest(canonical(binding));
  const prior = store.db.prepare('SELECT value FROM settings WHERE id=?').get(key);
  if (!prior) store.db.prepare('INSERT INTO settings VALUES(?,?)').run(key, canonical({ binding, complete: false }));
  return key;
}
export async function flushJobArtifacts(store, { connection, signal, limit = 10 }) {
  requireThat(Number.isSafeInteger(limit) && limit > 0 && limit <= 50, 'invalid_artifact_delivery_limit');
  const client = new RoomAgentClient(connection);
  const rows = store.db.prepare(`SELECT id,value FROM settings WHERE id LIKE 'artifact-delivery-%'
    AND json_extract(value,'$.complete')=0 AND json_extract(value,'$.binding.origin')=?
    AND json_extract(value,'$.binding.roomId')=? AND json_extract(value,'$.binding.memberId')=?
    ORDER BY rowid LIMIT ?`).all(connection.origin, connection.roomId, connection.memberId, limit);
  const results = []; let count = 0;
  for (const row of rows) {
    const saved = JSON.parse(row.value), b = saved.binding;
    if (saved.complete || b.origin !== connection.origin || b.roomId !== connection.roomId || b.memberId !== connection.memberId) continue;
    if (count++ >= limit) break;
    signal?.throwIfAborted();
    try {
      const result = await publishJobArtifacts(store, { connection, ...b, signal });
      const receipt = await client.replyAction('room_reply', { requestId: row.id, replyToId: b.messageId,
        body: JSON.stringify({ jobId: result.jobId, artifactDigest: result.artifactDigest, evidenceLocation: 'room',
          messageId: b.messageId, fileCount: result.files.length, files: result.files.slice(0, 8),
          hasMore: result.files.length > 8, next: 'List room files bound to messageId for remaining evidence.' }) }, { signal });
      requireThat(receipt.status === 'recorded', 'artifact_announcement_unconfirmed');
      store.db.prepare('UPDATE settings SET value=? WHERE id=?').run(canonical({ binding: b, complete: true, result }), row.id);
      results.push({ jobId: b.jobId, state: 'published' });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Rotate waiting records so an unavailable first delivery cannot starve
      // later results. Same durable ID and binding survive every retry.
      transaction(store, () => {
        if (store.db.prepare('DELETE FROM settings WHERE id=? AND value=?').run(row.id, row.value).changes)
          store.db.prepare('INSERT INTO settings VALUES(?,?)').run(row.id, row.value);
      });
      results.push({ jobId: b.jobId, state: 'waiting', reason: error.message });
    }
  }
  return results;
}
