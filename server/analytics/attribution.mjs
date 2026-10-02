// Signed attribution tokens. Web Crypto HMAC so the same module runs on Node
// and workerd. AN-1c mints these onto invite URLs and public CTAs.
// A legacy plain-text ref (a person's name) is never stored in analytics.

const TOKEN_MAX = 160;
const MAC_BYTES = 16;
export const REF_TTL_SEC = 90 * 24 * 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function b64urlToBytes(text) {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function keyBytes(key) {
  if (key == null || key === "") return null;
  if (key instanceof Uint8Array) return key.byteLength ? key : null;
  if (typeof key === "string") return key ? encoder.encode(key) : null;
  return null;
}

async function hmac16(secret, payload) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload)));
  return mac.slice(0, MAC_BYTES);
}

function timingSafeEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function payloadOf({ memberId, artifactId, loop, issuedAt }) {
  const body = {};
  if (typeof memberId === "string" && memberId) body.m = memberId;
  if (typeof artifactId === "string" && artifactId) body.a = artifactId;
  if (typeof loop === "string" && loop) body.l = loop;
  body.t = issuedAt;
  return bytesToB64url(encoder.encode(JSON.stringify(body)));
}

function parsePayload(encoded) {
  try {
    const parsed = JSON.parse(decoder.decode(b64urlToBytes(encoded)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!Number.isFinite(parsed.t)) return null;
    return {
      memberId: typeof parsed.m === "string" ? parsed.m : null,
      artifactId: typeof parsed.a === "string" ? parsed.a : null,
      loop: typeof parsed.l === "string" ? parsed.l : null,
      issuedAt: parsed.t
    };
  } catch {
    return null;
  }
}

export async function mintRef({ memberId = null, artifactId = null, loop = null, now = Date.now() } = {}, key = null) {
  const issuedAt = Math.floor(now / 1000);
  const payload = payloadOf({ memberId, artifactId, loop, issuedAt });
  const secret = keyBytes(key);
  const token = secret ? `r1.${payload}.${bytesToB64url(await hmac16(secret, payload))}` : `r0.${payload}`;
  if (token.length > TOKEN_MAX) throw new Error("attribution token exceeds 160 characters");
  return token;
}

export async function readRef(value, key = null, now = Date.now()) {
  if (typeof value !== "string" || !value) return { legacy: true };
  const parts = value.split(".");
  if (parts[0] !== "r0" && parts[0] !== "r1") return { legacy: true };
  if (parts[0] === "r0") {
    if (parts.length !== 2) return { trusted: false, tampered: true };
    const parsed = parsePayload(parts[1]);
    if (!parsed) return { trusted: false, tampered: true };
    return { trusted: false, ...parsed, expired: now / 1000 - parsed.issuedAt > REF_TTL_SEC };
  }
  if (parts.length !== 3) return { trusted: false, tampered: true };
  const parsed = parsePayload(parts[1]);
  if (!parsed) return { trusted: false, tampered: true };
  const secret = keyBytes(key);
  if (!secret) return { trusted: false, tampered: true };
  const expected = await hmac16(secret, parts[1]);
  let actual;
  try { actual = b64urlToBytes(parts[2]); }
  catch { return { trusted: false, tampered: true }; }
  if (!timingSafeEqual(actual, expected)) return { trusted: false, tampered: true };
  const expired = now / 1000 - parsed.issuedAt > REF_TTL_SEC;
  if (expired) return { trusted: false, expired: true, ...parsed };
  return { trusted: true, expired: false, ...parsed };
}

// What analytics is allowed to keep from a ref. Legacy names are dropped.
export async function attributionFromRef(value, key = null, now = Date.now()) {
  const read = await readRef(value, key, now);
  if (read.legacy || read.tampered || !read.trusted) {
    return { refMemberId: null, artifactId: null, loop: null, legacy: read.legacy === true };
  }
  return {
    refMemberId: read.memberId ?? null,
    artifactId: read.artifactId ?? null,
    loop: read.loop ?? null,
    legacy: false
  };
}
