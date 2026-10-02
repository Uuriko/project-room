// GitHub webhook signature check and event parse (VL-2a).
//
// GH-APP-2 mounts the route. This module only checks the raw body. The
// comparison is constant-time. Bodies over 1 MB are refused before the MAC
// runs. Secrets are arguments; this file does not read the environment.
const TEXT = new TextEncoder();
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
export const WEBHOOK_EVENTS = Object.freeze([
  "pull_request",
  "check_suite",
  "installation",
  "installation_repositories",
]);

function asBytes(rawBody) {
  if (rawBody instanceof Uint8Array) return rawBody;
  if (typeof rawBody === "string") return TEXT.encode(rawBody);
  if (rawBody instanceof ArrayBuffer) return new Uint8Array(rawBody);
  return TEXT.encode("");
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function decodeHex(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacSha256(secret, body) {
  const key = await crypto.subtle.importKey("raw", TEXT.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
}

export async function verifyWebhook({ rawBody, signature256, secret }) {
  const body = asBytes(rawBody);
  if (body.length > WEBHOOK_BODY_LIMIT) return { ok: false, reason: "oversize" };
  if (typeof secret !== "string" || secret.length === 0) return { ok: false, reason: "missing_signature" };
  const header = typeof signature256 === "string" ? signature256.trim() : "";
  if (!header.startsWith("sha256=")) return { ok: false, reason: "missing_signature" };
  const presented = decodeHex(header.slice("sha256=".length));
  const expected = await hmacSha256(secret, body);
  const candidate = presented ?? new Uint8Array(expected.length);
  const match = constantTimeEqual(expected, candidate);
  return match && presented ? { ok: true } : { ok: false, reason: "mismatch" };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const value = headers.get(name) ?? headers.get(name.toLowerCase());
    return value == null ? "" : String(value);
  }
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key == null || headers[key] == null ? "" : String(headers[key]);
}

export function parseEvent(headers, body) {
  const event = headerValue(headers, "x-github-event");
  const delivery = headerValue(headers, "x-github-delivery");
  if (!WEBHOOK_EVENTS.includes(event)) return { event: event || null, delivery: delivery || null, ignored: true };
  let payload = body;
  if (typeof body === "string") {
    try { payload = JSON.parse(body); }
    catch { return { event, delivery: delivery || null, ignored: true, reason: "invalid_json" }; }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { event, delivery: delivery || null, ignored: true, reason: "invalid_json" };
  }
  return {
    event,
    delivery: delivery || null,
    ignored: false,
    action: typeof payload.action === "string" ? payload.action : null,
    payload,
  };
}
