import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, lstatSync, constants } from "node:fs";
import { join } from "node:path";
import { assertServiceOrigin } from "./room-agent.mjs";
import { edgeDoorApiPath } from "../src/service-origin.js";
import { validId } from "../src/events.js";

export const artifactLimits = Object.freeze({ bytes: 4 * 1024 * 1024, chunkBytes: 512 * 1024, manifestBytes: 16384 });
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const requireThat = (yes, message) => { if (!yes) throw new Error(message); };

// All remote bytes remain data. No extraction, path from a manifest, redirect,
// ambient cookie or network destination supplied by a task is accepted.
export function roomFileTransport(connection) {
  assertServiceOrigin(connection.origin);
  requireThat(validId(connection.roomId) && validId(connection.memberId) && typeof connection.token === "string", "Invalid connection");
  return async (suffix, { method = "GET", body, signal } = {}) => {
    requireThat(/^\/(?:files(?:\/[a-zA-Z0-9_.:-]+(?:\/commit)?)?|commands|laptop-workers|laptop-transfers\/[a-zA-Z0-9_.:-]+)$/.test(suffix), "Invalid file operation");
    const response = await (connection.fetchImpl ?? fetch)(connection.origin + edgeDoorApiPath(connection.origin,
      `/api/rooms/${encodeURIComponent(connection.roomId)}${suffix}`), {
      method, redirect: "error", credentials: "omit",
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`Room file operation refused (${response.status})`); error.status = response.status; throw error;
    }
    if (method === "HEAD") return null;
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      requireThat(size <= 1500000, "Room file response exceeds limit"); chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}

export function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077)
    && stat.uid === process.getuid(), "Worker directory must be private and owned by this user");
}
export function savePrivate(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function cachedBytes(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); return readFileSync(fd); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function validateArtifact(manifest) {
  requireThat(exactObject(manifest, ["version", "sha256", "byteLength", "chunks"]) && manifest.version === 1
    && hash(manifest.sha256) && Number.isSafeInteger(manifest.byteLength) && manifest.byteLength >= 0
    && manifest.byteLength <= artifactLimits.bytes && Array.isArray(manifest.chunks)
    && manifest.chunks.length <= 8, "Invalid artifact manifest");
  let total = 0; const ids = new Set();
  for (const chunk of manifest.chunks) {
    requireThat(exactObject(chunk, ["id", "sha256", "byteLength"]) && validId(chunk.id) && hash(chunk.sha256)
      && Number.isSafeInteger(chunk.byteLength) && chunk.byteLength > 0 && chunk.byteLength <= artifactLimits.chunkBytes
      && !ids.has(chunk.id), "Invalid artifact chunk");
    total += chunk.byteLength; ids.add(chunk.id);
  }
  requireThat(total === manifest.byteLength, "Artifact size mismatch");
  return manifest;
}
function decodeAttachment(value, expected) {
  const file = value?.attachment;
  requireThat(file && file.id === expected.id && file.sha256 === expected.sha256 && file.byteLength === expected.byteLength
    && typeof file.data === "string" && file.data.length <= 1400000, "Attachment metadata mismatch");
  const bytes = Buffer.from(file.data, "base64");
  requireThat(bytes.toString("base64") === file.data && bytes.length === expected.byteLength
    && sha256(bytes) === expected.sha256, "Attachment checksum mismatch");
  return bytes;
}

// Stable operation + exact payload derive stable IDs. A retry first reads the
// existing object: even a lost stage/commit response does not duplicate bytes.
export async function uploadArtifact({ connection, bytes, operationId, messageId, signal, transport = roomFileTransport(connection) }) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= artifactLimits.bytes && validId(operationId) && validId(messageId), "Invalid artifact upload");
  const namespace = sha256(JSON.stringify([connection.roomId, connection.memberId, operationId, messageId, sha256(bytes)]));
  const manifest = { version: 1, sha256: sha256(bytes), byteLength: bytes.length, chunks: [] };
  const put = async (id, content, filename) => {
    const expected = { id, sha256: sha256(content), byteLength: content.length };
    let existing;
    try { existing = await transport(`/files/${id}`, { signal }); }
    catch (error) { if (error.status !== 404) throw error; }
    if (existing) {
      decodeAttachment(existing, expected);
      requireThat(existing.attachment.uploaderId === connection.memberId, "Artifact uploader mismatch");
    } else {
      const staged = await transport("/files", { method: "POST", signal,
        body: { id, filename, mediaType: "application/octet-stream", data: content.toString("base64") } });
      requireThat(staged?.attachment?.sha256 === expected.sha256 && staged.attachment.byteLength === content.length, "Upload checksum mismatch");
    }
    const committed = await transport(`/files/${id}/commit`, { method: "POST", body: { messageId }, signal });
    requireThat(committed?.status === "committed" && committed.attachment?.messageId === messageId, "Artifact commit unconfirmed");
    return expected;
  };
  for (let offset = 0; offset < bytes.length; offset += artifactLimits.chunkBytes) {
    signal?.throwIfAborted();
    manifest.chunks.push(await put(`artifact-${namespace}-${manifest.chunks.length}`, bytes.subarray(offset, offset + artifactLimits.chunkBytes), "artifact.part"));
  }
  const content = Buffer.from(JSON.stringify(validateArtifact(manifest)));
  return put(`artifact-${namespace}-manifest`, content, "artifact-manifest.json");
}

export async function downloadArtifact({ connection, reference, directory, signal, transport = roomFileTransport(connection) }) {
  requireThat(exactObject(reference, ["id", "sha256", "byteLength"]) && validId(reference.id) && hash(reference.sha256)
    && Number.isSafeInteger(reference.byteLength) && reference.byteLength > 0 && reference.byteLength <= artifactLimits.manifestBytes, "Invalid artifact reference");
  privateDirectory(directory);
  // Always reauthorize the manifest, including on fully cached downloads.
  const manifest = validateArtifact(JSON.parse(decodeAttachment(await transport(`/files/${reference.id}`, { signal }), reference)));
  const chunks = [];
  for (const chunk of manifest.chunks) {
    signal?.throwIfAborted();
    const path = join(directory, chunk.sha256);
    let bytes = cachedBytes(path);
    if (bytes && bytes.length === chunk.byteLength && sha256(bytes) === chunk.sha256) {
      // A local cache is never a membership or attachment-visibility grant.
      await transport(`/files/${chunk.id}`, { method: "HEAD", signal });
    } else {
      bytes = decodeAttachment(await transport(`/files/${chunk.id}`, { signal }), chunk);
      savePrivate(path, bytes);
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  requireThat(bytes.length === manifest.byteLength && sha256(bytes) === manifest.sha256, "Artifact checksum mismatch");
  return { bytes, manifest };
}
