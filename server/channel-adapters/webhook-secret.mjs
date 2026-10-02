// Shared secret handling for Slack and Discord incoming webhooks (HB-1a).
// The URL is a credential: validated, sealed with AES-256-GCM, and never
// copied into an error message. Delivery is a direct POST. Nothing here is
// mounted on a route.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { validateWebhookUrl, resolveWebhookTarget } from "../outbound-webhooks.mjs";

export class RelayError extends Error {
  constructor(code, message) { super(message); this.name = "RelayError"; this.code = code; }
}

const fail = (code, message) => { throw new RelayError(code, message); };

export function keyBytes(key) {
  if (Buffer.isBuffer(key) && key.length === 32) return key;
  if (typeof key === "string" && /^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, "hex");
  fail("invalid_webhook_secret", "Webhook secret key must be 32 bytes");
}

// https only, no userinfo, no port, no hash, plus the caller's host and path
// allowlist, plus the webhook SSRF guard (private and reserved addresses).
export function assertRelayUrl(url, { hosts, pathPrefix }) {
  let parsed;
  try {
    validateWebhookUrl(url);
    parsed = new URL(url);
  } catch {
    fail("invalid_webhook_url", "Webhook URL is not an allowed https endpoint");
  }
  const hostOk = hosts.includes(parsed.hostname);
  const pathOk = pathPrefix.some(prefix => parsed.pathname.startsWith(prefix));
  if (parsed.protocol !== "https:" || !hostOk || !pathOk || parsed.username || parsed.password
    || parsed.port || parsed.hash || parsed.search) {
    fail("invalid_webhook_url", "Webhook URL is not an allowed https endpoint");
  }
  return parsed.toString();
}

export function sealWebhookUrl(url, key, check) {
  const validated = check(url);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from("relay-webhook"));
  const body = Buffer.concat([cipher.update(validated, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openWebhookUrl(sealed, key, check) {
  try {
    if (typeof sealed !== "string" || sealed.length < 40 || sealed.length > 4000) fail("invalid_webhook_secret", "Webhook secret could not be opened");
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29 || bytes.toString("base64url") !== sealed) fail("invalid_webhook_secret", "Webhook secret could not be opened");
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from("relay-webhook"));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const url = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    return check(url);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    fail("invalid_webhook_secret", "Webhook secret could not be opened");
  }
}

const retryDelayMs = (header, now) => {
  if (!header) return 1000;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : 1000;
};

const headerValue = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
};

// One POST. A 429 waits out Retry-After when that wait fits in the 5s budget,
// then tries once more. A longer Retry-After is returned as retryAt so the
// caller can defer without blocking. The URL is not part of the result.
export async function postWebhook({ url, body, fetchFn = fetch, sleep = null, timeoutMs = 5000, lookup = undefined, now = Date.now }) {
  let target;
  try {
    target = await resolveWebhookTarget(url, lookup ? { lookup } : {});
  } catch {
    fail("invalid_webhook_url", "Webhook URL is not an allowed https endpoint");
  }
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error"
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
      return { ok: false, status: 0, reason: timedOut ? "timeout" : "delivery_failed", headers: { get: () => null } };
    } finally {
      clearTimeout(timer);
    }
  };
  let response = await attempt();
  if (response.status === 429) {
    const started = now();
    const delay = retryDelayMs(headerValue(response.headers, "retry-after"), started);
    if (delay <= timeoutMs) {
      if (sleep) await sleep(delay);
      response = await attempt();
    }
    if (response.status === 429) {
      const again = retryDelayMs(headerValue(response.headers, "retry-after"), now());
      return Object.freeze({ delivered: false, status: 429, retryAt: now() + again });
    }
  }
  if (response.reason && response.status === 0) return Object.freeze({ delivered: false, status: 0, reason: response.reason });
  if (!response.ok) return Object.freeze({ delivered: false, status: response.status ?? 0 });
  return Object.freeze({ delivered: true, status: response.status });
}
