// Web Push delivery: VAPID (RFC 8292) and encrypted payloads (RFC 8291 over
// the aes128gcm content coding of RFC 8188).
//
// Why this exists: server/notifications.mjs derives a per-member feed but says
// in its own header that it "delivers nothing". Nothing else in the product
// delivers either - server/channel-adapters/email.mjs declares outbound "none",
// and no wrangler config carries a cron trigger, a queue or an email binding.
// So a member who is not looking at the page has no way to learn that anything
// happened. This module is the delivery half.
//
// Constraints it is written under:
//   * Web Crypto only. The runtime package has zero dependencies and this must
//     run unchanged in a Cloudflare Worker, so there is no node:crypto here.
//   * Pure and injectable. Key generation and the random salt come in through
//     arguments with real defaults, so every value in a test can be pinned and
//     the published RFC vectors can be reproduced byte for byte.
//   * It sends nothing by itself. buildPushRequest returns a request
//     description; the caller performs the fetch. That keeps the crypto
//     testable without a network and keeps transport policy at the edge.
//
// Correctness here is not asserted, it is checked: tests/web-push.test.js runs
// the worked example in RFC 8291 section 5 and both RFC 8188 section 3 vectors
// through these functions and requires the exact published bytes, including
// every intermediate (ecdh_secret, PRK_key, IKM, PRK, CEK, NONCE).

const encoder = new TextEncoder();

const CONTENT_ENCODING = "aes128gcm";
const CEK_INFO = encoder.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = encoder.encode("Content-Encoding: nonce\0");
const KEY_INFO_PREFIX = encoder.encode("WebPush: info\0");
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const CEK_BYTES = 16;
const SALT_BYTES = 16;
const AUTH_SECRET_BYTES = 16;
const P256_PUBLIC_BYTES = 65;
const P256_PRIVATE_BYTES = 32;
const DEFAULT_RECORD_SIZE = 4096;
// A record must hold at least one plaintext octet, its padding delimiter and
// the GCM tag. RFC 8188 gives rs a floor of 18 for exactly this reason.
const MIN_RECORD_SIZE = TAG_BYTES + 2;
const DEFAULT_TTL_SECONDS = 2419200; // 28 days, the value RFC 8030 uses in its examples.
const MAX_VAPID_LIFETIME_SECONDS = 86400; // RFC 8292 section 2: at most 24 hours.

const subtle = () => {
  const web = globalThis.crypto;
  if (!web?.subtle) throw new Error("web_push_requires_web_crypto");
  return web.subtle;
};

const randomBytes = length => {
  const web = globalThis.crypto;
  if (!web?.getRandomValues) throw new Error("web_push_requires_web_crypto");
  return web.getRandomValues(new Uint8Array(length));
};

// ---------------------------------------------------------------------------
// base64url and byte helpers
// ---------------------------------------------------------------------------

export function toBase64Url(bytes) {
  const view = asBytes(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  if (typeof text !== "string") throw new Error("web_push_base64url_expected_string");
  const normalised = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) throw new Error("web_push_base64url_invalid");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return encoder.encode(value);
  throw new Error("web_push_expected_bytes");
}

function concatBytes(...parts) {
  const views = parts.map(asBytes);
  const total = views.reduce((sum, view) => sum + view.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const view of views) { out.set(view, offset); offset += view.length; }
  return out;
}

// ---------------------------------------------------------------------------
// HKDF (RFC 5869), written out rather than handed to subtle.deriveBits.
//
// RFC 8291 uses the extract and expand halves separately - it extracts with the
// auth secret, expands, then extracts again with the salt - and it publishes
// PRK_key and PRK as named intermediates. Keeping the halves apart lets the
// tests pin those intermediates instead of only the final output, so a wrong
// turn is caught at the step it happens rather than at the end.
// ---------------------------------------------------------------------------

async function hmacSha256(keyBytes, dataBytes) {
  const key = await subtle().importKey("raw", asBytes(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", key, asBytes(dataBytes)));
}

export const hkdfExtract = (salt, inputKeyMaterial) => hmacSha256(salt, inputKeyMaterial);

export async function hkdfExpand(pseudoRandomKey, info, length) {
  if (!Number.isInteger(length) || length < 1) throw new Error("web_push_hkdf_length_invalid");
  if (length > 255 * 32) throw new Error("web_push_hkdf_length_too_large");
  const infoBytes = asBytes(info);
  const out = new Uint8Array(length);
  let previous = new Uint8Array(0);
  let filled = 0;
  for (let counter = 1; filled < length; counter += 1) {
    previous = await hmacSha256(pseudoRandomKey, concatBytes(previous, infoBytes, Uint8Array.of(counter)));
    const take = Math.min(previous.length, length - filled);
    out.set(previous.subarray(0, take), filled);
    filled += take;
  }
  return out;
}

// ---------------------------------------------------------------------------
// P-256 keys
// ---------------------------------------------------------------------------

const publicKeyJwkParts = publicKey => {
  const bytes = asBytes(publicKey);
  if (bytes.length !== P256_PUBLIC_BYTES || bytes[0] !== 0x04) throw new Error("web_push_public_key_invalid");
  return { x: toBase64Url(bytes.subarray(1, 33)), y: toBase64Url(bytes.subarray(33, 65)) };
};

// A raw 32-octet private scalar carries no public point, and Web Crypto will
// not import one on its own. Both halves of a subscription's key pair are
// always available together here, so the JWK is assembled from the pair.
async function importPrivateKey(privateKey, publicKey, algorithm, usages) {
  const scalar = asBytes(privateKey);
  if (scalar.length !== P256_PRIVATE_BYTES) throw new Error("web_push_private_key_invalid");
  const { x, y } = publicKeyJwkParts(publicKey);
  return subtle().importKey("jwk", { kty: "EC", crv: "P-256", d: toBase64Url(scalar), x, y, ext: true }, algorithm, false, usages);
}

const importPublicKey = (publicKey, algorithm, usages) =>
  subtle().importKey("raw", asBytes(publicKey), algorithm, false, usages);

export async function generateKeyPair() {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  const jwk = await subtle().exportKey("jwk", pair.privateKey);
  return { publicKey, privateKey: fromBase64Url(jwk.d) };
}

// VAPID keys are an ordinary P-256 pair; the same bytes sign (ECDSA) and, for a
// different pair, agree (ECDH). Returned base64url because that is how they are
// stored as a Worker secret and shipped to the browser.
export async function generateVapidKeys() {
  const { publicKey, privateKey } = await generateKeyPair();
  return { publicKey: toBase64Url(publicKey), privateKey: toBase64Url(privateKey) };
}

// ---------------------------------------------------------------------------
// aes128gcm content coding (RFC 8188)
// ---------------------------------------------------------------------------

const encodeHeader = (salt, recordSize, keyid) => {
  const id = asBytes(keyid ?? new Uint8Array(0));
  if (id.length > 255) throw new Error("web_push_keyid_too_long");
  const fixed = new Uint8Array(SALT_BYTES + 4 + 1);
  fixed.set(asBytes(salt), 0);
  new DataView(fixed.buffer).setUint32(SALT_BYTES, recordSize, false);
  fixed[SALT_BYTES + 4] = id.length;
  return concatBytes(fixed, id);
};

// RFC 8188 section 2.3: the nonce for record n is the derived nonce XOR n, with
// n a 96-bit big-endian integer. Records are counted in the hundreds at most
// here, so the counter is XORed into the low 6 octets, which is the same value.
const recordNonce = (baseNonce, sequence) => {
  const nonce = Uint8Array.from(asBytes(baseNonce));
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("web_push_record_sequence_invalid");
  let remaining = sequence;
  for (let index = NONCE_BYTES - 1; index >= NONCE_BYTES - 6 && remaining > 0; index -= 1) {
    nonce[index] ^= remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining > 0) throw new Error("web_push_record_sequence_too_large");
  return nonce;
};

/**
 * Encrypt a body with the aes128gcm content coding.
 *
 * The input keying material is taken as given, which is what makes this
 * reusable: RFC 8188's own vectors supply the IKM directly, while Web Push
 * derives it first (see encryptPushPayload). Splitting the two is what lets
 * both be verified against published bytes.
 */
export async function encryptContent({ plaintext, inputKeyMaterial, salt, keyid, recordSize = DEFAULT_RECORD_SIZE }) {
  const body = asBytes(plaintext ?? new Uint8Array(0));
  const saltBytes = asBytes(salt);
  if (saltBytes.length !== SALT_BYTES) throw new Error("web_push_salt_invalid");
  if (!Number.isInteger(recordSize) || recordSize < MIN_RECORD_SIZE) throw new Error("web_push_record_size_invalid");

  const prk = await hkdfExtract(saltBytes, inputKeyMaterial);
  const cek = await hkdfExpand(prk, CEK_INFO, CEK_BYTES);
  const baseNonce = await hkdfExpand(prk, NONCE_INFO, NONCE_BYTES);
  const key = await subtle().importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);

  // One octet of every record is the padding delimiter and sixteen are the tag.
  const perRecord = recordSize - TAG_BYTES - 1;
  const parts = [encodeHeader(saltBytes, recordSize, keyid)];
  let offset = 0;
  let sequence = 0;
  // An empty body still produces one record: a lone delimiter, so the 0x02 end
  // marker is always present and a truncated stream is detectable.
  //
  // No zero padding is emitted. RFC 8188 makes padding optional - it exists to
  // blunt traffic analysis - and the worked example in its section 3.2 uses a
  // padding octet to demonstrate the feature. Two encoders that both follow the
  // RFC therefore produce different bytes for the same input, which is why the
  // multi-record test decrypts the published vector instead of trying to
  // reproduce that example's particular choice.
  do {
    const chunk = body.subarray(offset, offset + perRecord);
    offset += chunk.length;
    const last = offset >= body.length;
    const record = concatBytes(chunk, Uint8Array.of(last ? 2 : 1));
    const sealed = await subtle().encrypt({ name: "AES-GCM", iv: recordNonce(baseNonce, sequence), tagLength: TAG_BYTES * 8 }, key, record);
    parts.push(new Uint8Array(sealed));
    sequence += 1;
    if (last) break;
  } while (true);

  return { body: concatBytes(...parts), prk, contentEncryptionKey: cek, nonce: baseNonce };
}

/**
 * Decrypt an aes128gcm body, given the same input keying material.
 *
 * The product never needs this - the receiver is a browser - but interop does.
 * Matching a published ciphertext only proves an encoder agrees with whichever
 * optional choices the example author made; reading one back proves the header
 * parse, the record split, the nonce sequence, the delimiter rules and padding
 * removal all agree with the RFC. It is also the only way to debug a payload a
 * push service accepted but a browser could not read.
 */
export async function decryptContent({ body, inputKeyMaterial }) {
  const bytes = asBytes(body);
  if (bytes.length < SALT_BYTES + 5) throw new Error("web_push_body_truncated");
  const salt = bytes.subarray(0, SALT_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const recordSize = view.getUint32(SALT_BYTES, false);
  const idLength = bytes[SALT_BYTES + 4];
  const headerLength = SALT_BYTES + 5 + idLength;
  if (recordSize < MIN_RECORD_SIZE) throw new Error("web_push_record_size_invalid");
  if (bytes.length < headerLength) throw new Error("web_push_body_truncated");

  const keyid = bytes.subarray(SALT_BYTES + 5, headerLength);
  const prk = await hkdfExtract(salt, inputKeyMaterial);
  const cek = await hkdfExpand(prk, CEK_INFO, CEK_BYTES);
  const baseNonce = await hkdfExpand(prk, NONCE_INFO, NONCE_BYTES);
  const key = await subtle().importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);

  const chunks = [];
  let sequence = 0;
  let sawFinal = false;
  for (let offset = headerLength; offset < bytes.length; offset += recordSize) {
    const record = bytes.subarray(offset, Math.min(offset + recordSize, bytes.length));
    if (record.length <= TAG_BYTES) throw new Error("web_push_record_truncated");
    if (sawFinal) throw new Error("web_push_record_after_final");
    let opened;
    try {
      opened = new Uint8Array(await subtle().decrypt(
        { name: "AES-GCM", iv: recordNonce(baseNonce, sequence), tagLength: TAG_BYTES * 8 }, key, record
      ));
    } catch { throw new Error("web_push_record_authentication_failed"); }
    // Plaintext is data, then the delimiter, then optional zero padding.
    let end = opened.length;
    while (end > 0 && opened[end - 1] === 0) end -= 1;
    if (end === 0) throw new Error("web_push_record_delimiter_missing");
    const delimiter = opened[end - 1];
    if (delimiter !== 1 && delimiter !== 2) throw new Error("web_push_record_delimiter_invalid");
    if (delimiter === 2) sawFinal = true;
    chunks.push(opened.subarray(0, end - 1));
    sequence += 1;
  }
  if (!sawFinal) throw new Error("web_push_body_truncated");
  return { plaintext: concatBytes(...chunks), salt, recordSize, keyid, records: sequence };
}

// ---------------------------------------------------------------------------
// Web Push payload encryption (RFC 8291)
// ---------------------------------------------------------------------------

/**
 * Encrypt a payload for one push subscription.
 *
 * `senderKeys` is the ephemeral pair whose public half travels in the keyid, so
 * it is normally generated per message and left unset. Tests pass the pair from
 * the RFC to reproduce the published output.
 *
 * Returns the body plus every named intermediate from RFC 8291 section 3.4, so
 * a failure can be localised to the derivation step that produced it.
 */
export async function encryptPushPayload({
  payload,
  userAgentPublicKey,
  authSecret,
  senderKeys,
  salt = randomBytes(SALT_BYTES),
  recordSize = DEFAULT_RECORD_SIZE
}) {
  const receiverPublic = asBytes(userAgentPublicKey);
  publicKeyJwkParts(receiverPublic); // shape check, throws on a malformed point
  const auth = asBytes(authSecret);
  if (auth.length !== AUTH_SECRET_BYTES) throw new Error("web_push_auth_secret_invalid");

  const sender = senderKeys
    ? { publicKey: asBytes(senderKeys.publicKey), privateKey: asBytes(senderKeys.privateKey) }
    : await generateKeyPair();
  publicKeyJwkParts(sender.publicKey);

  const privateKey = await importPrivateKey(sender.privateKey, sender.publicKey, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
  const publicKey = await importPublicKey(receiverPublic, { name: "ECDH", namedCurve: "P-256" }, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));

  // RFC 8291 section 3.4. The auth secret is the salt of the first extract, and
  // both public keys are bound into the info so a key swap changes the IKM.
  const prkKey = await hkdfExtract(auth, ecdhSecret);
  const keyInfo = concatBytes(KEY_INFO_PREFIX, receiverPublic, sender.publicKey);
  const inputKeyMaterial = await hkdfExpand(prkKey, keyInfo, 32);

  const encrypted = await encryptContent({
    plaintext: payload,
    inputKeyMaterial,
    salt,
    keyid: sender.publicKey,
    recordSize
  });

  return {
    body: encrypted.body,
    salt: asBytes(salt),
    senderPublicKey: sender.publicKey,
    ecdhSecret,
    prkKey,
    inputKeyMaterial,
    prk: encrypted.prk,
    contentEncryptionKey: encrypted.contentEncryptionKey,
    nonce: encrypted.nonce
  };
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

const audienceFor = endpoint => {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error("web_push_endpoint_invalid"); }
  if (url.protocol !== "https:") throw new Error("web_push_endpoint_not_https");
  return url.origin;
};

/**
 * Build the Authorization header value for one push request.
 *
 * `subject` must be the mailto: or https: contact RFC 8292 requires, so a push
 * service with a problem has somewhere to write. `now` is injectable purely so
 * the expiry arithmetic can be tested without waiting.
 */
export async function vapidAuthorization({ endpoint, subject, publicKey, privateKey, lifetimeSeconds = 12 * 3600, now = Date.now() }) {
  if (typeof subject !== "string" || !/^(mailto:|https:)/.test(subject)) throw new Error("web_push_vapid_subject_invalid");
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1) throw new Error("web_push_vapid_lifetime_invalid");
  if (lifetimeSeconds > MAX_VAPID_LIFETIME_SECONDS) throw new Error("web_push_vapid_lifetime_too_long");

  const publicBytes = typeof publicKey === "string" ? fromBase64Url(publicKey) : asBytes(publicKey);
  const privateBytes = typeof privateKey === "string" ? fromBase64Url(privateKey) : asBytes(privateKey);
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({
    aud: audienceFor(endpoint),
    exp: Math.floor(now / 1000) + lifetimeSeconds,
    sub: subject
  })));
  const signingInput = `${header}.${claims}`;
  const key = await importPrivateKey(privateBytes, publicBytes, { name: "ECDSA", namedCurve: "P-256" }, ["sign"]);
  // Web Crypto returns the IEEE P1363 r||s pair that JWS ES256 wants, not DER.
  const signature = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput)));
  const token = `${signingInput}.${toBase64Url(signature)}`;
  return { authorization: `vapid t=${token}, k=${toBase64Url(publicBytes)}`, token, audience: audienceFor(endpoint) };
}

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

/**
 * Describe the HTTPS request that delivers one payload, without performing it.
 *
 * The caller does the fetch. Keeping the send outside means the whole of the
 * crypto is testable with no network and no push service, and the edge keeps
 * control of timeouts, retries and which failures retire a subscription.
 */
export async function buildPushRequest({ subscription, payload, vapid, ttlSeconds = DEFAULT_TTL_SECONDS, urgency, topic, salt, senderKeys, now = Date.now() }) {
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) throw new Error("web_push_endpoint_required");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) throw new Error("web_push_ttl_invalid");
  if (urgency !== undefined && !["very-low", "low", "normal", "high"].includes(urgency)) throw new Error("web_push_urgency_invalid");
  if (topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) throw new Error("web_push_topic_invalid");

  const headers = {
    TTL: String(ttlSeconds),
    "Content-Encoding": CONTENT_ENCODING,
    "Content-Type": "application/octet-stream"
  };
  if (urgency) headers.Urgency = urgency;
  if (topic) headers.Topic = topic;

  let body;
  if (payload === undefined || payload === null) {
    // RFC 8030 allows a bare wake with no payload. Nothing is encrypted, so the
    // content headers would be a lie; drop them.
    delete headers["Content-Encoding"];
    delete headers["Content-Type"];
  } else {
    const keys = subscription?.keys ?? {};
    if (!keys.p256dh || !keys.auth) throw new Error("web_push_subscription_keys_required");
    const encrypted = await encryptPushPayload({
      payload: typeof payload === "string" ? encoder.encode(payload) : asBytes(payload),
      userAgentPublicKey: fromBase64Url(keys.p256dh),
      authSecret: fromBase64Url(keys.auth),
      senderKeys,
      ...(salt ? { salt } : {})
    });
    body = encrypted.body;
    headers["Content-Length"] = String(body.length);
  }

  if (vapid) {
    const { authorization } = await vapidAuthorization({
      endpoint,
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      ...(vapid.lifetimeSeconds ? { lifetimeSeconds: vapid.lifetimeSeconds } : {}),
      now
    });
    headers.Authorization = authorization;
  }

  return { url: endpoint, method: "POST", headers, body };
}

export const constants = Object.freeze({
  CONTENT_ENCODING,
  DEFAULT_RECORD_SIZE,
  DEFAULT_TTL_SECONDS,
  MIN_RECORD_SIZE,
  SALT_BYTES,
  AUTH_SECRET_BYTES,
  P256_PUBLIC_BYTES,
  MAX_VAPID_LIFETIME_SECONDS
});
