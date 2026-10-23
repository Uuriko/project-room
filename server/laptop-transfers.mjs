import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { validId, ownMember } from "../src/events.js";

// Ephemeral rendezvous only: laptops retain all durable input and checkpoints.
// At most 8 MiB of decoded payload per store; eviction is a resumable outage.
export const laptopTransferLimits = Object.freeze({ chunkBytes: 524288, maxBytes: 64 * 1024 ** 3, sessions: 16, perSender: 2, ttlMs: 120000 });
const stores = new WeakMap();
const fail = (status, code) => { throw new ServiceError(status, code, code.replaceAll("_", " ")); };
const check = (yes, code = "invalid_transfer") => { if (!yes) fail(422, code); };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function laptopTransfer(store, roomId, memberId, id, data, now = Date.now()) {
  check(validId(id) && data && typeof data.action === "string");
  let sessions = stores.get(store);
  if (!sessions) { sessions = new Map(); stores.set(store, sessions); }
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  const key = JSON.stringify([roomId, id]); let session = sessions.get(key);
  if (data.action === "offer") {
    check(exact(data, ["action", "recipientId", "sha256", "byteLength"])
      && validId(data.recipientId) && data.recipientId !== memberId && hash(data.sha256)
      && Number.isSafeInteger(data.byteLength) && data.byteLength >= 0 && data.byteLength <= laptopTransferLimits.maxBytes);
    const members = store.room(roomId).state.members;
    if (ownMember(members, data.recipientId)?.active !== true) fail(404, "transfer_recipient_unavailable");
    if (session) {
      if (session.senderId !== memberId || session.recipientId !== data.recipientId
        || session.sha256 !== data.sha256 || session.byteLength !== data.byteLength) fail(409, "transfer_conflict");
    } else {
      if (sessions.size >= laptopTransferLimits.sessions
        || [...sessions.values()].filter(item => item.senderId === memberId).length >= laptopTransferLimits.perSender) fail(429, "transfer_capacity");
      session = { id, roomId, senderId: memberId, recipientId: data.recipientId, sha256: data.sha256,
        byteLength: data.byteLength, wanted: null, chunk: null, complete: false };
      sessions.set(key, session);
    }
  }
  if (!session || ![session.senderId, session.recipientId].includes(memberId)) fail(404, "transfer_not_found");
  const members = store.room(roomId).state.members;
  if (![session.senderId, session.recipientId].every(member => ownMember(members, member)?.active === true)) {
    sessions.delete(key); fail(403, "transfer_membership_revoked");
  }
  session.expiresAt = now + laptopTransferLimits.ttlMs;
  const count = Math.ceil(session.byteLength / laptopTransferLimits.chunkBytes);
  const receiver = () => { if (memberId !== session.recipientId) fail(403, "transfer_recipient_required"); };
  const sender = () => { if (memberId !== session.senderId) fail(403, "transfer_sender_required"); };
  if (data.action === "want") {
    receiver(); check(exact(data, ["action", "index"]) && Number.isSafeInteger(data.index) && data.index >= 0 && data.index < count);
    if (session.complete) fail(409, "transfer_complete");
    if (session.wanted !== data.index) session.chunk = null;
    session.wanted = data.index;
  } else if (data.action === "put") {
    sender(); check(exact(data, ["action", "index", "sha256", "data"]) && hash(data.sha256)
      && typeof data.data === "string" && data.data.length <= 4 * Math.ceil(laptopTransferLimits.chunkBytes / 3));
    if (session.complete || data.index !== session.wanted) fail(409, "transfer_chunk_not_requested");
    const bytes = Buffer.from(data.data, "base64");
    check(bytes.toString("base64") === data.data && bytes.length === Math.min(laptopTransferLimits.chunkBytes,
      session.byteLength - data.index * laptopTransferLimits.chunkBytes) && digest(bytes) === data.sha256, "transfer_checksum_mismatch");
    session.chunk = { index: data.index, sha256: data.sha256, bytes };
  } else if (data.action === "take") {
    receiver(); check(exact(data, ["action", "index"]) && Number.isSafeInteger(data.index));
    if (!session.chunk || session.chunk.index !== data.index) fail(409, "transfer_chunk_pending");
    return { index: data.index, sha256: session.chunk.sha256, data: session.chunk.bytes.toString("base64") };
  } else if (data.action === "complete") {
    receiver(); check(exact(data, ["action", "sha256"]) && data.sha256 === session.sha256, "transfer_checksum_mismatch");
    session.complete = true; session.chunk = null; session.wanted = null;
  } else if (data.action === "cancel") {
    check(exact(data, ["action"])); sessions.delete(key); return { state: "cancelled" };
  } else if (data.action === "inspect") check(exact(data, ["action"]));
  else if (data.action !== "offer") fail(422, "invalid_transfer_action");
  return { version: 1, kind: "laptop", id, senderId: session.senderId, recipientId: session.recipientId,
    sha256: session.sha256, byteLength: session.byteLength, chunkBytes: laptopTransferLimits.chunkBytes,
    wanted: session.wanted, chunkReady: session.chunk !== null, complete: session.complete, expiresAt: session.expiresAt };
}
