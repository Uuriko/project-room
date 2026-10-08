// Payload reference convention helpers (WAVE-300).
//
// Events carry hashes and sizes, never bytes:
//   { "payload_ref": { "sha256": "…64-hex…", "byte_length": 123456, "media_type": "image/png" } }
// Payloads at or under payloadLimits.inlineBytes keep riding inline as
// { mediaType, data } (canonical base64), exactly as today.
//
// Every function takes the RoomStore-shaped `store` and talks to the
// content-addressed blob store through `store.payloads` (PayloadStore from
// server/payload-store.mjs — async put/get/pin). The http layer attaches it
// lazily (`store.payloads ??= new PayloadStore(...)`) so read-only store
// opens never pay the schema-ensure write; a sibling wires it in
// server/store.mjs proper.

import { ServiceError } from "./service-error.mjs";
import { payloadLimits } from "./payload-schema.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const SHA256_HEX = /^[0-9a-f]{64}$/;
// Same media-type policy as server/payload-store.mjs (checkedFile): the regex
// is duplicated here so the inline path can shape-check without uploading.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const payloadsOf = store => store?.payloads
  ?? fail(500, "payload_store_unavailable", "The payload store is not attached to this server");

// Canonical base64 with no whitespace, mirroring validPayloadData in
// server/payload-store.mjs (which remains the authority on the upload path).
function isCanonicalBase64(value) {
  if (typeof value !== "string") return false;
  if (value.length > 4 * Math.ceil(payloadLimits.maxBlobBytes / 3)) return false;
  if (value.length % 4 !== 0) return false;
  if (value.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function decodeInlineData(dataBase64) {
  if (!isCanonicalBase64(dataBase64)) fail(422, "invalid_payload", "data must be canonical base64 with no whitespace");
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length > payloadLimits.maxBlobBytes) fail(413, "payload_too_large", "Payload exceeds the 25 MiB payload size limit");
  return bytes;
}

function checkInlineMediaType(mediaType) {
  if (typeof mediaType !== "string") fail(422, "invalid_payload", "mediaType must be a string");
  const type = mediaType.toLowerCase();
  if (!MEDIA_TYPE.test(type)) fail(422, "invalid_payload", "mediaType must be a type/subtype media type");
  return type;
}

// Shape check for a payload_ref value: exactly { sha256, byte_length,
// media_type }, no I/O.
export function isPayloadRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("sha256") || !keys.includes("byte_length") || !keys.includes("media_type")) return false;
  if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) return false;
  if (!Number.isInteger(value.byte_length) || value.byte_length < 0) return false;
  return typeof value.media_type === "string";
}

// Throwing version of isPayloadRef. Also enforces the media-type shape so a
// ref can never name a blob under a malformed type.
export function validatePayloadRef(value) {
  if (!isPayloadRef(value)) fail(422, "invalid_payload_ref", "payload_ref must be { sha256, byte_length, media_type }");
  if (!MEDIA_TYPE.test(value.media_type.toLowerCase())) {
    fail(422, "invalid_payload_ref", "payload_ref media_type must be a type/subtype media type");
  }
  return value;
}

// Route one inline payload: decoded bytes at or under inlineBytes stay
// inline (returned unchanged apart from media-type normalization); anything
// larger is uploaded through the store and comes back as { payload_ref }.
// Small payloads keep working exactly as today — full backward compat.
export async function externalizePayload({ mediaType, dataBase64 } = {}, store) {
  const payloads = payloadsOf(store);
  const type = checkInlineMediaType(mediaType);
  const bytes = decodeInlineData(dataBase64);
  if (bytes.length <= payloadLimits.inlineBytes) return { mediaType: type, data: dataBase64 };
  // put() re-validates (including the executable/script blocklist) and is
  // idempotent: same bytes -> same sha.
  const stored = await payloads.put({ mediaType, dataBase64 });
  return { payload_ref: { sha256: stored.sha256, byte_length: stored.byte_length, media_type: type } };
}

// Resolve one payload value: { payload_ref } -> { mediaType, bytes } via the
// store (404 payload_not_found when the blob is gone); an inline
// { mediaType, data } decodes straight through.
export async function resolvePayload(value, store) {
  const payloads = payloadsOf(store);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "payload_ref") {
      const ref = validatePayloadRef(value.payload_ref);
      const row = await payloads.get(ref.sha256);
      if (row.byte_length !== ref.byte_length) {
        fail(422, "invalid_payload_ref", "payload_ref byte_length does not match the stored blob");
      }
      return { mediaType: row.media_type, bytes: Buffer.from(row.dataBase64, "base64") };
    }
    if (keys.length === 2 && keys.includes("mediaType") && keys.includes("data")) {
      const type = checkInlineMediaType(value.mediaType);
      return { mediaType: type, bytes: decodeInlineData(value.data) };
    }
  }
  fail(422, "invalid_payload_ref", "Expected { payload_ref } or an inline { mediaType, data } payload");
}

// Deep-collect every payload_ref object in a JSON value (arrays and plain
// objects). A `payload_ref` key is an explicit claim of the convention: its
// value is validated and a malformed claim throws 422 invalid_payload_ref
// instead of dangling silently. Bare ref-shaped objects (not under a
// payload_ref key) are collected on shape alone — pinPayloadRefs validates
// them before writing. Cycle-safe; JSON event bodies cannot cycle, but a
// hostile caller could hand us a live object graph.
export function collectPayloadRefs(value, into = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return into;
  seen.add(value);
  if (isPayloadRef(value)) {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadRefs(item, into, seen);
    return into;
  }
  if (Object.hasOwn(value, "payload_ref")) {
    // An explicit payload_ref claim: malformed claims fail fast (422)
    // instead of dangling silently.
    into.push(validatePayloadRef(value.payload_ref));
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "payload_ref") continue;
    collectPayloadRefs(item, into, seen);
  }
  return into;
}

// Pin every payload_ref found in an event body. Pins are INSERT OR IGNORE,
// so re-pinning the same reference is idempotent.
//
// Transactionality: PayloadStore.pin() performs its INSERT with no
// suspension points under LocalBlobBackend, so every pin() call below
// executes synchronously at call time. When the caller invokes
// pinPayloadRefs inside store.transaction(...), the pin rows land atomically
// with the referencing write; the returned promise only settles afterwards.
// Callers that need the 422 surface BEFORE their write should validate with
// collectPayloadRefs + validatePayloadRef first (the message-post path does).
export async function pinPayloadRefs(eventBody, { kind, roomId, refId } = {}, store) {
  const payloads = payloadsOf(store);
  const refs = collectPayloadRefs(eventBody);
  for (const ref of refs) validatePayloadRef(ref);
  if (typeof kind !== "string" || !kind || typeof roomId !== "string" || !roomId
    || typeof refId !== "string" || !refId) {
    fail(422, "invalid_pin", "kind, roomId and refId are required");
  }
  const pending = refs.map(ref => payloads.pin({ sha256: ref.sha256, kind, roomId, refId }));
  await Promise.all(pending);
  return refs;
}
