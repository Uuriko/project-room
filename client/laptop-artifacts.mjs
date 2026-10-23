import { createReadStream, readFileSync, existsSync, renameSync, statfsSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateDirectory, savePrivate, sha256, roomFileTransport } from "./room-artifact-transfer.mjs";
import { validId } from "../src/events.js";

export const laptopArtifactLimits = Object.freeze({ chunkBytes: 524288, defaultBytes: 1024 ** 3, maxBytes: 64 * 1024 ** 3 });
const ensure = (yes, message) => { if (!yes) throw new Error(message); };
export function validateLaptopReference(value) {
  ensure(value?.kind === "laptop" && value.version === 1 && validId(value.id) && validId(value.senderId) && validId(value.recipientId)
    && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0 && value.byteLength <= laptopArtifactLimits.maxBytes, "Invalid laptop artifact");
  return value;
}
export async function hashLocalFile(path, signal) {
  const hash = createHash("sha256"); let byteLength = 0;
  for await (const bytes of createReadStream(path, { highWaterMark: laptopArtifactLimits.chunkBytes, signal })) {
    hash.update(bytes); byteLength += bytes.length;
  }
  return { sha256: hash.digest("hex"), byteLength };
}
export async function offerLaptopArtifact({ connection, path, transferId, recipientId, signal, transport = roomFileTransport(connection), maxBytes = laptopArtifactLimits.defaultBytes }) {
  ensure(validId(transferId) && validId(recipientId), "Invalid transfer identity");
  const metadata = await hashLocalFile(path, signal);
  ensure(Number.isSafeInteger(maxBytes) && maxBytes <= laptopArtifactLimits.maxBytes && metadata.byteLength <= maxBytes, "Laptop artifact exceeds local limit");
  const reference = { version: 1, kind: "laptop", id: transferId, senderId: connection.memberId, recipientId, ...metadata };
  await transport(`/laptop-transfers/${transferId}`, { method: "POST", signal, body: { action: "offer", recipientId, ...metadata } });
  return reference;
}

// Both peers dial Room over HTTPS. No SSH, inbound listener, VPN, public laptop
// address, room database blob or arbitrary file path is part of the protocol.
export async function serveLaptopArtifact({ connection, path, reference, signal = AbortSignal.timeout(3600000), transport = roomFileTransport(connection), pollMs = 500 }) {
  validateLaptopReference(reference); ensure(connection.memberId === reference.senderId, "Sender mismatch");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    ensure((await file.stat()).isFile(), "Source must be a regular file");
    while (!signal?.aborted) {
      try {
      const state = await transport(`/laptop-transfers/${reference.id}`, { method: "POST", signal,
        body: { action: "offer", recipientId: reference.recipientId, sha256: reference.sha256, byteLength: reference.byteLength } });
      if (state.complete) return { state: "receiver_verified", sha256: reference.sha256 };
      if (state.wanted !== null && !state.chunkReady) {
        const offset = state.wanted * laptopArtifactLimits.chunkBytes;
        ensure(Number.isSafeInteger(state.wanted) && offset >= 0 && offset < reference.byteLength, "Invalid requested chunk");
        const bytes = Buffer.alloc(Math.min(laptopArtifactLimits.chunkBytes, reference.byteLength - offset));
        const read = await file.read(bytes, 0, bytes.length, offset); ensure(read.bytesRead === bytes.length, "Source changed during transfer");
        try { await transport(`/laptop-transfers/${reference.id}`, { method: "POST", signal,
          body: { action: "put", index: state.wanted, sha256: sha256(bytes), data: bytes.toString("base64") } }); }
        catch (error) { if (![404, 409].includes(error.status)) throw error; }
      }
      } catch (error) {
        if (![404, 409, 429, 503].includes(error.status) && !["TypeError", "TimeoutError"].includes(error.name)) throw error;
      }
      await delay(pollMs, undefined, { signal });
    }
    signal?.throwIfAborted();
  } finally { await file.close(); }
}

export async function receiveLaptopArtifact({ connection, reference, directory, signal = AbortSignal.timeout(3600000), transport = roomFileTransport(connection),
  maxBytes = laptopArtifactLimits.defaultBytes, reserveBytes = 1024 ** 3, pollMs = 500 }) {
  validateLaptopReference(reference);
  ensure(connection.memberId === reference.recipientId && Number.isSafeInteger(maxBytes) && maxBytes <= laptopArtifactLimits.maxBytes
    && reference.byteLength <= maxBytes, "Laptop artifact not permitted");
  privateDirectory(directory);
  const id = sha256(JSON.stringify(reference)), partial = join(directory, `${id}.part`), checkpoint = join(directory, `${id}.json`), destination = join(directory, reference.sha256);
  const call = body => transport(`/laptop-transfers/${reference.id}`, { method: "POST", signal, body });
  const check = async () => {
    const state = await call({ action: "inspect" });
    ensure(state.senderId === reference.senderId && state.recipientId === reference.recipientId
      && state.sha256 === reference.sha256 && state.byteLength === reference.byteLength && state.chunkBytes === laptopArtifactLimits.chunkBytes, "Transfer binding mismatch");
    return state;
  };
  await check(); // A cached file does not bypass current Room authorization.
  if (existsSync(destination)) {
    const existing = await hashLocalFile(destination, signal);
    ensure(existing.sha256 === reference.sha256 && existing.byteLength === reference.byteLength, "Cached file corrupt");
    await call({ action: "complete", sha256: reference.sha256 }); return { path: destination, ...existing };
  }
  const free = statfsSync(directory); ensure(free.bavail * free.bsize >= reference.byteLength + reserveBytes, "Insufficient disk headroom");
  let hashes = existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, "utf8")).hashes : [];
  ensure(Array.isArray(hashes) && hashes.length <= Math.ceil(reference.byteLength / laptopArtifactLimits.chunkBytes)
    && hashes.every(value => /^[a-f0-9]{64}$/.test(value)), "Invalid transfer checkpoint");
  const file = await open(partial, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    // Verify every durable checkpoint chunk before resuming. Unjournaled tail
    // bytes are truncated; final whole-file verification still checks the source.
    let offset = 0;
    for (const hash of hashes) {
      const bytes = Buffer.alloc(Math.min(laptopArtifactLimits.chunkBytes, reference.byteLength - offset));
      const read = await file.read(bytes, 0, bytes.length, offset);
      ensure(read.bytesRead === bytes.length && sha256(bytes) === hash, "Transfer checkpoint corrupt"); offset += bytes.length;
    }
    await file.truncate(offset);
    while (offset < reference.byteLength) {
      signal?.throwIfAborted();
      const index = hashes.length;
      try {
        await check(); await call({ action: "want", index });
        const part = await call({ action: "take", index });
        const bytes = Buffer.from(part.data ?? "", "base64");
        ensure(bytes.toString("base64") === part.data && part.index === index && sha256(bytes) === part.sha256
          && bytes.length === Math.min(laptopArtifactLimits.chunkBytes, reference.byteLength - offset), "Transfer chunk corrupt");
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, offset + written);
          ensure(result.bytesWritten > 0, "Transfer disk write failed"); written += result.bytesWritten;
        }
        await file.sync(); hashes = [...hashes, part.sha256];
        savePrivate(checkpoint, JSON.stringify({ hashes })); offset += bytes.length;
      } catch (error) {
        if (![404, 409, 429, 503].includes(error.status) && !["TypeError", "TimeoutError"].includes(error.name)) throw error;
        await delay(pollMs, undefined, { signal });
      }
    }
  } finally { await file.close(); }
  const result = await hashLocalFile(partial, signal);
  ensure(result.sha256 === reference.sha256 && result.byteLength === reference.byteLength, "Transfer final checksum mismatch");
  renameSync(partial, destination);
  await call({ action: "complete", sha256: reference.sha256 });
  return { path: destination, ...result };
}
